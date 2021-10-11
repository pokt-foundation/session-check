import { Pocket, Account, Configuration, HttpRpcProvider, PocketRpcProvider } from '@pokt-network/pocket-js'

const clientPrivateKey: string = process.env.GATEWAY_CLIENT_PRIVATE_KEY || ""
const clientPassphrase: string = process.env.GATEWAY_CLIENT_PASSPHRASE || ''

const DEFAULT_DISPATCHER_LIST = 'https://peer-1.nodes.pokt.network:4200'
  .split(',')
  .map((uri) => new URL(uri))

const defaultConfig = {
  maxDispatchers: 20,
  maxSessions: 100000,
  consensusNodeCount: 5,
  requestTimeout: 4000, // 4 seconds
  acceptDisputedResponses: false,
  sessionBlockFrequency: 4,
  blockTime: 1038000,
  maxSessionRefreshRetries: 10200,
  validateRelayResponses: undefined,
  rejectSelfSignedCertificates: undefined,
  useLegacyTxCodec: true,
}

export function getPocketDispatchers(): URL[] {
  return DEFAULT_DISPATCHER_LIST
}

export function getRPCProvider(): HttpRpcProvider | PocketRpcProvider {
  return new HttpRpcProvider(new URL(DEFAULT_DISPATCHER_LIST[0]))
}

export function getPocketConfig(): Configuration {
  return new Configuration(
    defaultConfig.maxDispatchers,
    defaultConfig.maxSessions,
    defaultConfig.consensusNodeCount,
    defaultConfig.requestTimeout,
    defaultConfig.acceptDisputedResponses,
    defaultConfig.sessionBlockFrequency,
    defaultConfig.blockTime,
    defaultConfig.maxSessionRefreshRetries,
    defaultConfig.validateRelayResponses,
    defaultConfig.rejectSelfSignedCertificates,
    defaultConfig.useLegacyTxCodec,
  )
}

// Unlock client account for relay signing
export async function unlockAccount(pocket: Pocket): Promise<Pocket> {
  try {
    const importAccount = await pocket.keybase.importAccount(Buffer.from(clientPrivateKey, 'hex'), clientPassphrase)

    if (importAccount instanceof Account) {
      await pocket.keybase.unlockAccount(importAccount.addressHex, clientPassphrase, 0)
    }
  } catch (e) {
    console.error('error unlocking account:', e)
    throw new Error('Unable to import or unlock base client account')
  }

  return pocket
}