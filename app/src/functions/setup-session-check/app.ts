import connect from '../../lib/db'
import ApplicationModel, { IApplication } from '../../models/Application';
import Redis from 'ioredis'
import { Pocket, PocketAAT, Session } from '@pokt-network/pocket-js';
import { getPocketDispatchers, getRPCProvider, getPocketConfig, unlockAccount, getAppsInNetwork } from '../../lib/pocket';
import { getApps } from 'pocket-tools'
import { SyncChecker } from '../../lib/sync-checker';
import shortID from 'shortid'
import ChainModel, { IChain } from '../../models/Blockchain';

const REDIS_HOST = process.env.REDIS_HOST || 'redis'
const REDIS_PORT = process.env.REDIS_PORT || '6379'

const ALTRUISTS = JSON.parse(process.env.ALTRUISTS || '{}')

const DEFAULT_SYNC_ALLOWANCE: number = parseInt(process.env.DEFAULT_SYNC_ALLOWANCE || '') || 5

const redis = new Redis(parseInt(REDIS_PORT), REDIS_HOST)

async function syncCheckApp(pocket: Pocket, blockchain: IChain, application: IApplication, requestID: string) {
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

  const nodes = syncChecker.consensusFilter({
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

  return nodes
}

exports.handler = async () => {
  await connect()

  const requestID = shortID.generate()

  const apps = await ApplicationModel.find()

  const blockchains = await ChainModel.find()

  const networkApps = await getAppsInNetwork()

  const app = apps.find(a => a.name === 'local-development')
  // @ts-ignore
  const nt = networkApps.find(n => n.publicKey === app.gatewayAAT.applicationPublicKey)

  const blockchain = await blockchains.find(bl => bl._id === '0023')

  let pocket = new Pocket(getPocketDispatchers(), getRPCProvider(), getPocketConfig())

  pocket = await unlockAccount(pocket)

  const nodes = await syncCheckApp(pocket, blockchain as IChain, app as IApplication, '1234')

  return { 'message': nodes }
}
