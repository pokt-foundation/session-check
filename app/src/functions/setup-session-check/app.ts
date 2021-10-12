import connect from '../../lib/db'
import ApplicationModel, { IApplication } from '../../models/Application';
import Redis from 'ioredis'
import { Pocket, PocketAAT, Session, Node } from '@pokt-network/pocket-js';
import { getPocketDispatchers, getRPCProvider, getPocketConfig, unlockAccount, getAppsInNetwork } from '../../lib/pocket';
import { SyncChecker } from '../../lib/sync-checker';
import shortID from 'shortid'
import ChainModel, { IChain } from '../../models/Blockchain';

const REDIS_HOST = process.env.REDIS_HOST || 'redis'
const REDIS_PORT = process.env.REDIS_PORT || '6379'
const ALTRUISTS = JSON.parse(process.env.ALTRUISTS || '{}')
const DEFAULT_SYNC_ALLOWANCE: number = parseInt(process.env.DEFAULT_SYNC_ALLOWANCE || '') || 5

const redis = new Redis(parseInt(REDIS_PORT), REDIS_HOST)

async function syncCheckApp(pocket: Pocket, blockchain: IChain, application: IApplication, requestID: string): Promise<Node[]> {
  const aatParams: [string, string, string, string] = [
    application.gatewayAAT.version,
    application.gatewayAAT.clientPublicKey,
    application.gatewayAAT.applicationPublicKey,
    application.gatewayAAT.applicationSignature,
  ]

  const pocketAAT = new PocketAAT(...aatParams)

  const pocketSession = await pocket.sessionManager.getCurrentSession(
    pocketAAT,
    blockchain._id,
    pocket.configuration
  )

  if (!(pocketSession instanceof Session)) {
    throw new Error(`unable to obtain a session for ${application.gatewayAAT.applicationPublicKey}`)
  }

  const { sessionKey, sessionNodes } = pocketSession

  const syncChecker = new SyncChecker(redis, DEFAULT_SYNC_ALLOWANCE)

  // @ts-ignore
  const { syncCheckOptions } = blockchain._doc

  syncCheckOptions.body = syncCheckOptions.body ? syncCheckOptions.body.replace(/\\"/g, '"') : ''

  const syncCheckKey = `sync-check-${sessionKey}`

  // Cache is stale, start a new cache fill
  // First check cache lock key; if lock key exists, return full node set
  const syncLock = await redis.get('lock-' + syncCheckKey)

  if (syncLock) {
    return sessionNodes
  } else {
    // Set lock as this thread checks the sync with 60 second ttl.
    // If any major errors happen below, it will retry the sync check every 60 seconds.
    await redis.set('lock-' + syncCheckKey, 'true', 'EX', 60)
  }

  const nodes = await syncChecker.consensusFilter({
    pocket,
    requestID,
    pocketAAT,
    sessionKey,
    nodes: sessionNodes,
    syncCheckOptions: syncCheckOptions,
    blockchainID: blockchain._id,
    blockchainSyncBackup: String(ALTRUISTS[blockchain._id]),
    applicationID: application.id,
    applicationPublicKey: application.gatewayAAT.applicationPublicKey,
    pocketConfiguration: getPocketConfig(),
  })

  // Erase failure mark of synced nodes
  for (const node of nodes) {
    await redis.set(
      blockchain._id + '-' + node.publicKey + '-failure',
      'false',
      'EX',
      60 * 60 * 24 * 30
    )
  }

  await redis.set(
    syncCheckKey,
    JSON.stringify(nodes.map(node => node.publicKey)),
    'EX',
    nodes.length > 0 ? 300 : 30 // will retry sync check every 30 seconds if no nodes are in sync
  )

  return nodes
}

exports.handler = async () => {
  await connect()

  const requestID = shortID.generate()

  const apps = await ApplicationModel.find()

  const blockchains = await ChainModel.find()
  const blockchainsMap: Map<string, IChain> = new Map<string, IChain>()

  for (const blockchain of blockchains) {
    blockchainsMap.set(blockchain._id, blockchain)
  }

  const networkApps = await getAppsInNetwork()
  const publicKeyChainsMap: Map<string, string[]> = new Map<string, string[]>()

  for (const ntApp of networkApps) {
    publicKeyChainsMap.set(ntApp.publicKey, ntApp.chains)
  }

  let pocket = new Pocket(getPocketDispatchers(), getRPCProvider(), getPocketConfig())

  pocket = await unlockAccount(pocket)

  // Only perform sync check on apps made using the gateway
  const gatewayApps = apps.filter((app) => publicKeyChainsMap.get(app?.gatewayAAT?.applicationPublicKey))

  const syncCheckPromises: Promise<Node[]>[] = []

  for (const app of gatewayApps) {
    const chains = publicKeyChainsMap.get(app?.gatewayAAT?.applicationPublicKey || '')
    if (!chains) {
      continue
    }

    for (const chain of chains) {
      const blockchain = blockchainsMap.get(chain)
      if (!blockchain) {
        continue
      }
      syncCheckPromises.push(syncCheckApp(pocket, blockchain, app as IApplication, requestID))
    }
  }

  await Promise.allSettled(syncCheckPromises)

  return { 'message': 'nodes' }
}
