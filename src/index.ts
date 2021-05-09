import type { Redis } from 'ioredis'
import chunk from 'chunk'

interface Options {
  /**
   * Override group name
   */
  groupName?: string

  /**
   * IORedis Connection Object
   */
  ioredis: Redis
}

interface BlockReadOptions {
  /**
   * Time (in ms) to block for (default: 1000)
   *
   * Set to `0` to block until new data arrives
   */
  blockMS?: number

  /**
   * Max number of items to read (default: 1)
   */
  count?: number
}

interface Entry {
  /**
   * Unique Entry ID
   */
  id: string
  /**
   * Data for this Entry
   */
  value: Record<string, string>

  /**
   * Mark this entry as acknowledged
   */
  ack: () => Promise<void>
}

/**
 * @param key Redis Key to use for the Stream
 */
export const createStreamer = (key: string, options: Options) => {
  const db = options.ioredis
  const streamName = key
  const groupName = options.groupName ?? key

  const createGroup = async () => {
    try {
      await db.xgroup('CREATE', key, groupName, '0', 'MKSTREAM')
    } catch {
      // No-op
    }
  }

  /**
   * Write values into the stream
   * @param data Data to write
   */
  const write = async (data: [key: string, value: string | Buffer] | Record<string, string | Buffer>) => {
    const mapped = Array.isArray(data) ? [data] : Object.entries(data)
    const flat = mapped.flat()

    await db.xadd(streamName, '*', ...flat)
  }

  const readInternal: (consumer: string, count: number, block?: number) => Promise<Array<Entry>> = async (consumer, count, block) => {
    await createGroup()

    const commands = [consumer, 'COUNT', count]
    if (block) commands.push('BLOCK', block)
    commands.push('STREAMS', streamName, '>')

    const resp = await db.xreadgroup('GROUP', groupName, ...commands)
    if (resp === null) return []

    const records = resp.flatMap(([_, entries]) => entries.map(([key, values]) => {
      const chunked = chunk(values, 2)
      const record: Record<string, string> = Object.fromEntries(chunked)

      return {
        id: key,
        value: record,

        ack: async () => {
          await db.xack(streamName, groupName, key)
        }
      }
    }))

    return records
  }

  /**
   * Read data from the stream
   *
   * Returns null if there are no values waiting
   * @param consumer Unique identifer for this consumer
   * @param count Max number of items to read (default: 1)
   */
  const read = async (consumer: string, count = 1) => {
    return readInternal(consumer, count)
  }

  const blockRead = async (consumer: string, options?: BlockReadOptions) => {
    const count = options?.count ?? 1
    const blockMS = options?.blockMS ?? 1000

    return readInternal(consumer, count, blockMS)
  }

  return { write, read, blockRead }
}
