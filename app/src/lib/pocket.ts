import { Pocket, Account, Configuration, HttpRpcProvider, PocketRpcProvider, Application } from '@pokt-network/pocket-js'
import axios, { AxiosError } from 'axios'

const clientPrivateKey: string = process.env.ACCOUNT_PRIVATE_KEY || ""
// Cannot be empty or will result in an error
const clientPassphrase: string = process.env.ACCOUNT_PASSPHRASE || 'placeholder'

const DEFAULT_DISPATCHER_LIST = 'https://peer-1.nodes.pokt.network:4200'
  .split(',')
  .map((uri) => new URL(uri))

const defaultConfig = {
  maxDispatchers: 20,
  maxSessions: 100000,
  consensusNodeCount: 5,
  requestTimeout: 12000, // 12 seconds
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
    } else {
      throw importAccount as Error
    }
  } catch (e) {
    console.error('error unlocking account:', e)
    throw new Error('Unable to import or unlock base client account')
  }

  return pocket
}

// TODO: Replace by pocket-tools once the issue is fixed:
// https://github.com/pokt-foundation/pocket-tools/issues/9
export async function getAppsInNetwork(): Promise<
  Omit<Application, 'toJSON' | 'isValid'>[]
> {
  const page = 1
  const applicationsList: Omit<Application, 'toJSON' | 'isValid'>[] = []
  const perPage = 3000

  try {
    const {
      // @ts-ignore
      data: { result: apps },
    } = await axios.post(`${DEFAULT_DISPATCHER_LIST.toString()}v1/query/apps`, {
      opts: {
        page,
        per_page: perPage,
      },
    })

    for (const app of apps) {
      const {
        address,
        chains,
        public_key: publicKey,
        jailed,
        max_relays: maxRelays,
        status,
        staked_tokens: stakedTokens,
        unstaking_time: unstakingCompletionTime,
      } = app
      const networkApp: Omit<Application, 'toJSON' | 'isValid'> = {
        address,
        chains,
        publicKey,
        jailed,
        maxRelays,
        status,
        stakedTokens,
        unstakingCompletionTime,
      }
      applicationsList.push(networkApp)
    }
  } catch (err) {
    console.error(
      'failed retrieving applications from network',
      (err as AxiosError).message
    )
    throw err
  }

  return applicationsList
}