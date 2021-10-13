import connect from '../../lib/db'
import ApplicationModel, { IApplication } from '../../models/Application';
import Redis from 'ioredis'
import { Pocket, PocketAAT, Session, Node } from '@pokt-network/pocket-js';
import { getPocketDispatchers, getRPCProvider, getPocketConfig, unlockAccount, getAppsInNetwork } from '../../lib/pocket';
import { SyncChecker } from '../../lib/sync-checker';
import shortID from 'shortid'
import ChainModel, { IChain } from '../../models/Blockchain';

const REDIS_HOSTS = (process.env.REDIS_HOSTS || 'localhost').split(',')
const REDIS_PORTS = (process.env.REDIS_PORTS || '6379').split(',')

const ALTRUISTS = JSON.parse(process.env.ALTRUISTS || '{}')
const DEFAULT_SYNC_ALLOWANCE: number = parseInt(process.env.DEFAULT_SYNC_ALLOWANCE || '') || 5

const redisInstances = REDIS_HOSTS.map((host, idx) => new Redis(parseInt(REDIS_PORTS[idx]), host))

const redis = new Redis(parseInt(REDIS_PORTS[0]), REDIS_HOSTS[0])

// Sets the same redis value to all the available instances
async function multiSetRedis(instances: Redis.Redis[], key: string, value: string, expiryMode: string, ttl: number): Promise<void> {
  const operations: Promise<"OK" | null>[] = []

  for (const instance of instances) {
    operations.push(instance.set(key, value, expiryMode, ttl))
  }

  await Promise.allSettled(operations)
}

type MultiGet = {
  instance: Redis.Redis
  value: string
}

/**
 * Get the same redis value from all the available instances
 * @param instances redis instances
 * @param key key to search
 * @return Array.{<Object>} instances and their respective values
 */
async function multiGetRedis(instances: Redis.Redis[], key: string): Promise<MultiGet[]> {
  const operations: Promise<string | null>[] = []

  for (const instance of instances) {
    operations.push(instance.get(key))
  }

  const results = await Promise.allSettled(operations)

  const succeeded: MultiGet[] = []

  for (const [idx, result] of results.entries()) {
    if (result.status === 'fulfilled' && result.value !== null) {
      succeeded.push({ instance: instances[idx], value: result.value })
    }
  }

  return succeeded
}

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

  const syncChecker = new SyncChecker(DEFAULT_SYNC_ALLOWANCE)

  // @ts-ignore
  const { syncCheckOptions } = blockchain._doc

  syncCheckOptions.body = syncCheckOptions.body ? syncCheckOptions.body.replace(/\\"/g, '"') : ''

  const syncCheckKey = `sync-check-${sessionKey}`

  // Cache is stale, start a new cache fill
  // First check cache lock key; if lock key exists, return full node set
  const syncLock = await multiGetRedis(redisInstances, 'lock-' + syncCheckKey)

  // Removes instances that have a cache lock key
  const instances = redisInstances.filter((ins => !syncLock.some((syncIns) => ins === syncIns.instance)))

  if (instances.length === 0) {
    return sessionNodes
  } else {
    // Set lock as this thread checks the sync with 60 second ttl.
    // If any major errors happen below, it will retry the sync check every 60 seconds.
    await multiSetRedis(instances, 'lock-' + syncCheckKey, 'true', 'EX', 60)
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
    await multiSetRedis(instances,
      blockchain._id + '-' + node.publicKey + '-failure',
      'false',
      'EX',
      60 * 60 * 24 * 30
    )
  }

  await multiSetRedis(
    instances,
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
