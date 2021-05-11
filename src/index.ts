import chunk from 'chunk'
import Redis from 'ioredis'
import type { Redis as IORedis } from 'ioredis'

interface Options {
  /**
   * Override group name
   */
  groupName?: string

  /**
   * Redis Connection Info
   */
  connection?: {
    host: string
    port?: number
    username?: string
    pass?: string
    db?: number
  }

  /**
   * IORedis Connection Object
   */
  ioredis?: IORedis

  /**
   * Maximum time (in ms) that a message can remain pending before being claimed (default: 5000)
   */
  maxPendingTime?: number
}

interface BlockReadOptions {
  /**
   * Time (in ms) to block for (default: 1000)
   *
   * Set to `0` to block until new data arrives
   */
  blockMS?: number

  /**
   * Max number of items to read (default: 10)
   */
  count?: number
}

interface ReadIteratorOptions {
  /**
   * Time (in ms) to block for polling data (default: 1000)
   *
   * Set to `0` to block until new data arrives
   */
  maxBlockTime?: number

  /**
   * Max number of items to poll for at a time (default: 10)
   */
  maxItems?: number

  /**
   * Whether to automatically claim values (default: true)
   */
  autoclaim?: boolean
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
 * @param options Stream Options
 */
export const createStream = (key: string, options: Options) => {
  const resolveDB = () => {
    if (options.ioredis) return options.ioredis
    if (!options.connection) {
      throw new Error(
        'must specify either options.connection or options.ioredis'
      )
    }

    return new Redis({
      host: options.connection.host,
      port: options.connection.port,
      username: options.connection.username,
      password: options.connection.pass,
      db: options.connection.db,
    })
  }

  const db = resolveDB()
  const streamName = key
  const groupName = options.groupName ?? key

  const createGroup = async () => {
    try {
      await db.xgroup('CREATE', key, groupName, '0', 'MKSTREAM')
    } catch {
      // No-op
    }
  }

  const parseResponse: (
    data: [id: string, values: string[]]
  ) => Entry[] = data =>
    data.map(([key, values]) => {
      const chunked = chunk(values, 2)
      const record = Object.fromEntries(chunked) as Record<string, string>

      return {
        id: key,
        value: record,

        ack: async () => {
          await db.xack(streamName, groupName, key)
        },
      }
    })

  const readInternal: (
    consumer: string,
    count: number,
    block?: number
  ) => Promise<Entry[]> = async (consumer, count, block) => {
    await createGroup()

    const commands = [consumer, 'COUNT', count]
    if (block) commands.push('BLOCK', block)
    commands.push('STREAMS', streamName, '>')

    const resp = await db.xreadgroup('GROUP', groupName, ...commands)
    if (resp === null) return []

    const records = resp.flatMap(([_, entry]) =>
      parseResponse(entry as [string, string[]])
    )

    return records
  }

  const claimInternal = async (consumer: string, count: number) => {
    const idle = options?.maxPendingTime ?? 1000
    const resp = await db.xautoclaim(
      streamName,
      groupName,
      consumer,
      idle,
      '0',
      'COUNT',
      count
    )

    const records = parseResponse(resp[1])
    return records
  }

  return Object.freeze({
    /**
     * Write values into the stream
     * @param data Data to write
     */
    async write(
      data:
        | [key: string, value: string | Buffer]
        | Record<string, string | Buffer>
    ): Promise<void> {
      const mapped = Array.isArray(data) ? [data] : Object.entries(data)
      const flat = mapped.flat()

      await db.xadd(streamName, '*', ...flat)
    },

    /**
     * Read data from the stream
     *
     * Returns null if there are no values waiting
     * @param consumer Unique identifer for this consumer
     * @param count Max number of items to read (default: 10)
     */
    async read(consumer: string, count = 10): Promise<Entry[]> {
      return readInternal(consumer, count)
    },

    /**
     * Blocking read data from the stream
     *
     * Returns null if there are no values waiting
     * @param consumer Unique identifer for this consumer
     * @param options
     */
    async blockRead(
      consumer: string,
      options?: BlockReadOptions
    ): Promise<Entry[]> {
      const count = options?.count ?? 10
      const blockMS = options?.blockMS ?? 1000

      return readInternal(consumer, count, blockMS)
    },

    /**
     * Create an async iterator for this stream
     * @param consumer Unique identifer for this consumer
     * @param options
     */
    async *readIterator(
      consumer: string,
      options?: ReadIteratorOptions
    ): AsyncGenerator<Entry, never, void> {
      const count = options?.maxItems ?? 10
      const blockMS = options?.maxBlockTime ?? 1000
      const autoclaim = options?.autoclaim ?? true

      /* eslint-disable no-await-in-loop */
      while (true) {
        const values = await readInternal(consumer, count, blockMS)

        for (const entry of values) {
          yield entry
        }

        if (autoclaim) {
          const values = await claimInternal(consumer, count)
          for (const entry of values) {
            yield entry
          }
        }
      }
      /* eslint-enable no-await-in-loop */
    },

    /**
     * Claims idle entries and returns them
     * @param consumer Unique identifer for this consumer
     * @param count Max number of items to read (default: 10)
     */
    async claim(consumer: string, count = 10): Promise<void> {
      await claimInternal(consumer, count)
    },
  })
}
