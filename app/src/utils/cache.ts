import { Redis } from 'ioredis'
import { getAddressFromPublicKey } from 'pocket-tools'
import axios, { AxiosError } from 'axios'
import extractDomain from 'extract-domain'

const ALTRUIST_URL: string = JSON.parse(process.env.ALTRUISTS || '{}')?.['0001']

export async function getNodeNetworkData(redis: Redis, publicKey: string, requestID?: string): Promise<NodeURLInfo> {
  let nodeUrl: NodeURLInfo = { serviceURL: '', serviceDomain: '' }

  // Might come empty or undefined on relay failure
  if (!publicKey) {
    return nodeUrl
  }

  const address = await getAddressFromPublicKey(publicKey)
  const nodeCached = await redis.get(`node-${publicKey}`)

  if (nodeCached) {
    nodeUrl = JSON.parse(nodeCached)
    return nodeUrl
  }

  try {
    // @ts-ignore
    const { service_url } = (await axios.post(`${ALTRUIST_URL}/v1/query/node`, { address })).data

    nodeUrl = { serviceURL: service_url, serviceDomain: extractDomain(service_url) }

    await redis.set(`node-${publicKey}`, JSON.stringify(nodeUrl), 'EX', 60 * 60 * 6) // 6 hours
  } catch (e) {
    console.warn(`Failure getting node network data: ${(e as AxiosError).message}`, {
      serviceNode: publicKey,
      requestID,
    })
  }

  return nodeUrl
}

type NodeURLInfo = {
  serviceURL: string
  serviceDomain: string
}