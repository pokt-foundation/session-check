import { Configuration, HTTPMethod, Node, Pocket, PocketAAT, RelayResponse } from '@pokt-network/pocket-js'
import { Redis } from 'ioredis'
import { checkEnforcementJSON, getNodeNetworkData } from '../utils'

import axios from 'axios'

export class SyncChecker {
  defaultSyncAllowance: number

  constructor(defaultSyncAllowance: number) {
    this.defaultSyncAllowance = defaultSyncAllowance
  }

  async consensusFilter({
    nodes,
    requestID,
    syncCheckOptions,
    blockchainID,
    blockchainSyncBackup,
    applicationID,
    applicationPublicKey,
    pocket,
    pocketAAT,
    pocketConfiguration,
    sessionKey,
  }: ConsensusFilterOptions): Promise<Node[]> {
    // Blockchain records passed in with 0 sync allowance are missing the 'syncAllowance' field in MongoDB
    console.debug('SYNC CHECK OPTIONS', syncCheckOptions)
    syncCheckOptions.allowance = (syncCheckOptions?.allowance || 0) > 0 ?
      syncCheckOptions.allowance : this.defaultSyncAllowance

    const syncedNodes: Node[] = []
    const syncedNodesList: string[] = []

    // Value is an array of node public keys that have passed sync checks for this session in the past 5 minutes

    // Fires all 5 sync checks synchronously then assembles the results
    const nodeSyncLogs = await this.getNodeSyncLogs(
      nodes,
      requestID,
      syncCheckOptions,
      blockchainID,
      applicationID,
      applicationPublicKey,
      pocket,
      pocketAAT,
      pocketConfiguration,
      sessionKey
    )

    let errorState = false

    // This should never happen
    if (nodes.length > 2 && nodeSyncLogs.length <= 2) {
      console.error('SYNC CHECK ERROR: fewer than 3 nodes returned sync', {
        requestID: requestID,
        relayType: '',
        blockchainID,
        typeID: '',
        serviceNode: '',
        error: '',
        elapsedTime: '',
        sessionKey,
      })
      errorState = true
    }

    let currentBlockHeight = 0

    // Sort NodeSyncLogs by blockHeight
    nodeSyncLogs.sort((a, b) => b.blockHeight - a.blockHeight)

    // If top node is still 0, or not a number, return all nodes due to check failure
    if (
      nodeSyncLogs.length === 0 ||
      nodeSyncLogs[0].blockHeight === 0 ||
      typeof nodeSyncLogs[0].blockHeight !== 'number' ||
      nodeSyncLogs[0].blockHeight % 1 !== 0
    ) {
      console.error('SYNC CHECK ERROR: top synced node result is invalid ' + JSON.stringify(nodeSyncLogs), {
        requestID: requestID,
        relayType: '',
        blockchainID,
        typeID: '',
        serviceNode: '',
        error: '',
        elapsedTime: '',
        sessionKey,
      })
      errorState = true
    } else {
      currentBlockHeight = nodeSyncLogs[0].blockHeight
    }

    // If there's at least 2 nodes, make sure at least two of them agree on current highest block to prevent one node
    // from being wildly off
    if (
      !errorState &&
      nodeSyncLogs.length >= 2 &&
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      nodeSyncLogs[0].blockHeight > nodeSyncLogs[1].blockHeight + syncCheckOptions.allowance!
    ) {
      console.error('SYNC CHECK ERROR: two highest nodes could not agree on sync', {
        requestID: requestID,
        relayType: '',
        blockchainID,
        typeID: '',
        serviceNode: '',
        error: '',
        elapsedTime: '',
        sessionKey,
      })
      errorState = true
    }

    // Consult Altruist for sync source of truth
    const altruistBlockHeight = await this.getSyncFromAltruist(syncCheckOptions, blockchainSyncBackup)

    if (altruistBlockHeight === 0 || isNaN(altruistBlockHeight)) {
      // Failure to find sync from consensus and altruist
      console.info('SYNC CHECK ALTRUIST FAILURE: ' + altruistBlockHeight, {
        requestID: requestID,
        relayType: '',
        blockchainID,
        typeID: '',
        serviceNode: 'ALTRUIST',
        error: '',
        elapsedTime: '',
        sessionKey,
      })

      if (errorState) {
        return nodes
      }
    } else {
      console.info('SYNC CHECK ALTRUIST CHECK: ' + altruistBlockHeight, {
        requestID: requestID,
        relayType: '',
        blockchainID,
        typeID: '',
        serviceNode: 'ALTRUIST',
        error: '',
        elapsedTime: '',
        sessionKey,
      })
    }

    // Go through nodes and add all nodes that are current or within 1 block -- this allows for block processing times
    for (const nodeSyncLog of nodeSyncLogs) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const allowedBlockHeight = nodeSyncLog.blockHeight + syncCheckOptions.allowance!

      const { serviceURL, serviceDomain } = await getNodeNetworkData(nodeSyncLog.node.publicKey, requestID)

      if (allowedBlockHeight >= currentBlockHeight && allowedBlockHeight >= altruistBlockHeight) {
        console.info(
          'SYNC CHECK IN-SYNC: ' + nodeSyncLog.node.publicKey + ' height: ' + nodeSyncLog.blockHeight,
          {
            requestID: requestID,
            relayType: '',
            blockchainID,
            typeID: '',
            serviceNode: nodeSyncLog.node.publicKey,
            error: '',
            elapsedTime: '',
            serviceURL,
            serviceDomain,
            sessionKey,
          }
        )

        // In-sync: add to nodes list
        syncedNodes.push(nodeSyncLog.node)
        syncedNodesList.push(nodeSyncLog.node.publicKey)
      } else {
        console.info('SYNC CHECK BEHIND: ' + nodeSyncLog.node.publicKey + ' height: ' + nodeSyncLog.blockHeight, {
          requestID: requestID,
          relayType: '',
          blockchainID,
          typeID: '',
          serviceNode: nodeSyncLog.node.publicKey,
          error: '',
          elapsedTime: '',
          serviceURL,
          serviceDomain,
          sessionKey,
        })
      }
    }

    console.info('SYNC CHECK COMPLETE: ' + syncedNodes.length + ' nodes in sync', {
      requestID: requestID,
      relayType: '',
      typeID: '',
      serviceNode: '',
      error: '',
      elapsedTime: '',
      blockchainID,
      sessionKey,
    })

    // If one or more nodes of this session are not in sync, fire a consensus relay with the same check.
    // This will penalize the out-of-sync nodes and cause them to get slashed for reporting incorrect data.
    if (syncedNodes.length < nodes.length) {
      const consensusResponse = await pocket.sendRelay(
        syncCheckOptions.body,
        blockchainID,
        pocketAAT,
        this.updateConfigurationConsensus(pocketConfiguration),
        undefined,
        'POST' as HTTPMethod,
        undefined,
        undefined,
        true,
        'synccheck'
      )

      console.info('SYNC CHECK CHALLENGE: ' + JSON.stringify(consensusResponse), {
        requestID: requestID,
        relayType: '',
        typeID: '',
        serviceNode: '',
        error: '',
        elapsedTime: '',
        blockchainID,
        sessionKey,
      })
    }
    return syncedNodes
  }

  async getSyncFromAltruist(syncCheckOptions: SyncCheckOptions, blockchainSyncBackup: string): Promise<number> {
    // Remove user/pass from the altruist URL
    const redactedAltruistURL = blockchainSyncBackup.replace(/[\w]*:\/\/[^/]*@/g, '')
    const syncCheckPath = syncCheckOptions.path ? syncCheckOptions.path : ''

    try {
      const syncResponse = await axios({
        method: 'POST',
        url: `${blockchainSyncBackup}${syncCheckPath}`,
        data: syncCheckOptions.body,
        headers: { 'Content-Type': 'application/json' },
      })

      if (!(syncResponse instanceof Error)) {
        const payload = syncResponse.data // object that includes 'resultKey'
        const blockHeight = this.parseBlockFromPayload(payload, syncCheckOptions.resultKey)

        return blockHeight
      }
      return 0
    } catch (e) {
      console.error(e as unknown as any, {
        requestID: '',
        relayType: 'FALLBACK',
        typeID: '',
        serviceNode: 'fallback:' + redactedAltruistURL,
        error: '',
        elapsedTime: '',

      })
    }
    return 0
  }

  async getNodeSyncLogs(
    nodes: Node[],
    requestID: string,
    syncCheckOptions: SyncCheckOptions,
    blockchainID: string,
    applicationID: string,
    applicationPublicKey: string,
    pocket: Pocket,
    pocketAAT: PocketAAT,
    pocketConfiguration: Configuration,
    sessionKey: string
  ): Promise<NodeSyncLog[]> {
    const nodeSyncLogs: NodeSyncLog[] = []
    const promiseStack: Promise<NodeSyncLog>[] = []

    // Set to junk values first so that the Promise stack can fill them later
    const rawNodeSyncLogs: NodeSyncLog[] = [
      <NodeSyncLog>{},
      <NodeSyncLog>{},
      <NodeSyncLog>{},
      <NodeSyncLog>{},
      <NodeSyncLog>{},
    ]

    for (const node of nodes) {
      promiseStack.push(
        this.getNodeSyncLog(
          node,
          requestID,
          syncCheckOptions,
          blockchainID,
          applicationID,
          applicationPublicKey,
          pocket,
          pocketAAT,
          pocketConfiguration,
          sessionKey
        )
      )
    }

    [rawNodeSyncLogs[0], rawNodeSyncLogs[1], rawNodeSyncLogs[2], rawNodeSyncLogs[3], rawNodeSyncLogs[4]] =
      await Promise.all(promiseStack)

    for (const rawNodeSyncLog of rawNodeSyncLogs) {
      if (typeof rawNodeSyncLog === 'object' && rawNodeSyncLog?.blockHeight > 0) {
        nodeSyncLogs.push(rawNodeSyncLog)
      }
    }
    return nodeSyncLogs
  }

  async getNodeSyncLog(
    node: Node,
    requestID: string,
    syncCheckOptions: SyncCheckOptions,
    blockchainID: string,
    applicationID: string,
    applicationPublicKey: string,
    pocket: Pocket,
    pocketAAT: PocketAAT,
    pocketConfiguration: Configuration,
    sessionKey: string
  ): Promise<NodeSyncLog> {
    // Pull the current block from each node using the blockchain's syncCheck as the relay
    const relayResponse = await pocket.sendRelay(
      syncCheckOptions.body,
      blockchainID,
      pocketAAT,
      this.updateConfigurationTimeout(pocketConfiguration),
      undefined,
      'POST' as HTTPMethod,
      syncCheckOptions.path,
      node,
      false,
      'synccheck'
    )

    const { serviceURL, serviceDomain } = await getNodeNetworkData(node.publicKey, requestID)

    if (relayResponse instanceof RelayResponse && checkEnforcementJSON(relayResponse.payload)) {
      const payload = JSON.parse(relayResponse.payload) // object that may not include 'resultKey'

      const blockHeight = this.parseBlockFromPayload(payload, syncCheckOptions.resultKey)

      // Create a NodeSyncLog for each node with current block
      const nodeSyncLog = {
        node: node,
        blockchainID,
        blockHeight,
      } as NodeSyncLog

      console.info('SYNC CHECK RESULT: ' + JSON.stringify(nodeSyncLog), {
        requestID: requestID,
        relayType: '',
        typeID: '',
        serviceNode: node.publicKey,
        error: '',
        elapsedTime: '',
        blockchainID,
        serviceURL,
        serviceDomain,
        sessionKey,
      })
      // Success
      return nodeSyncLog
    } else if (relayResponse instanceof Error) {
      console.error('SYNC CHECK ERROR: ' + JSON.stringify(relayResponse), {
        requestID: requestID,
        relayType: '',
        typeID: '',
        serviceNode: node.publicKey,
        error: '',
        elapsedTime: '',
        blockchainID,
        serviceURL,
        serviceDomain,
        sessionKey,
      })

    } else {
      console.error('SYNC CHECK ERROR UNHANDLED: ' + JSON.stringify(relayResponse), {
        requestID: requestID,
        relayType: '',
        typeID: '',
        serviceNode: node.publicKey,
        error: '',
        elapsedTime: '',
        blockchainID,
        serviceURL,
        serviceDomain,
        sessionKey,
      })
    }
    // Failed
    const nodeSyncLog = {
      node: node,
      blockchainID,
      blockHeight: 0,
    } as NodeSyncLog

    return nodeSyncLog
  }

  updateConfigurationConsensus(pocketConfiguration: Configuration): Configuration {
    return new Configuration(
      pocketConfiguration.maxDispatchers,
      pocketConfiguration.maxSessions,
      5,
      12000,
      false,
      pocketConfiguration.sessionBlockFrequency,
      pocketConfiguration.blockTime,
      pocketConfiguration.maxSessionRefreshRetries,
      pocketConfiguration.validateRelayResponses,
      pocketConfiguration.rejectSelfSignedCertificates
    )
  }

  updateConfigurationTimeout(pocketConfiguration: Configuration): Configuration {
    return new Configuration(
      pocketConfiguration.maxDispatchers,
      pocketConfiguration.maxSessions,
      pocketConfiguration.consensusNodeCount,
      12000,
      pocketConfiguration.acceptDisputedResponses,
      pocketConfiguration.sessionBlockFrequency,
      pocketConfiguration.blockTime,
      pocketConfiguration.maxSessionRefreshRetries,
      pocketConfiguration.validateRelayResponses,
      pocketConfiguration.rejectSelfSignedCertificates
    )
  }

  // TODO: We might want to support result keys in nested objects
  parseBlockFromPayload(payload: object, syncCheckResultKey: string): number {
    // @ts-ignore
    const rawHeight = payload[`${syncCheckResultKey}`] || '0'

    const blockHeight = parseInt(rawHeight)

    return blockHeight
  }
}

type NodeSyncLog = {
  node: Node
  blockchainID: string
  blockHeight: number
}

export interface SyncCheckOptions {
  path?: string
  body: string
  resultKey: string
  allowance?: number
}

export type ConsensusFilterOptions = {
  nodes: Node[]
  requestID: string
  syncCheckOptions: SyncCheckOptions
  blockchainID: string
  blockchainSyncBackup: string
  applicationID: string
  applicationPublicKey: string
  pocket: Pocket
  pocketAAT: PocketAAT
  pocketConfiguration: Configuration
  sessionKey: string
}
