import connect from '../../lib/db'
import ApplicationModel, { IApplication } from '../../models/Application';
import Redis from 'ioredis'
import { Pocket, PocketAAT, Session } from '@pokt-network/pocket-js';
import { getPocketDispatchers, getRPCProvider, getPocketConfig, unlockAccount } from '../../lib/pocket';
import { getApps } from 'pocket-tools'

const REDIS_HOST = process.env.REDIS_HOST || ''
const REDIS_PORT = process.env.REDIS_PORT || ''

const redis = new Redis(parseInt(REDIS_PORT), REDIS_HOST)

async function processApp(pocket: Pocket, blockchainID: string, application: IApplication) {
  const aatParams: [string, string, string, string] = [
    application.gatewayAAT.version,
    application.gatewayAAT.clientPublicKey,
    application.gatewayAAT.applicationPublicKey,
    application.gatewayAAT.applicationSignature,
  ]

  const pocketAAT = new PocketAAT(...aatParams)

  const pocketSession = await pocket.sessionManager.getCurrentSession(
    pocketAAT,
    blockchainID,
    pocket.configuration
  )

  if (!(pocketSession instanceof Session)) {
    console.log('error')
  }
}

exports.handler = async () => {
  // await connect()

  // const apps = await ApplicationModel.find()

  // const networkApps = await getApps()

  // console.log(networkApps)

  // let pocket = new Pocket(getPocketDispatchers(), getRPCProvider(), getPocketConfig())

  // pocket = await unlockAccount(pocket)

  return { 'message': 'ok' }
}

