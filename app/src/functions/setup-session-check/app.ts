import connect from '../../lib/db'
import ApplicationModel from '../../models/Application';
import Redis from 'ioredis'
import { Pocket } from '@pokt-network/pocket-js';
import { getPocketDispatchers, getRPCProvider, getPocketConfig, unlockAccount } from '../../lib/pocket';

const REDIS_HOST = process.env.REDIS_HOST || ''
const REDIS_PORT = process.env.REDIS_PORT || ''

const redis = new Redis(parseInt(REDIS_PORT), REDIS_HOST)

exports.handler = async () => {
  await connect()

  const _apps = await ApplicationModel.find()

  let pocket = new Pocket(getPocketDispatchers(), getRPCProvider(), getPocketConfig())

  pocket = await unlockAccount(pocket)

  return { 'message': 'ok' }
}