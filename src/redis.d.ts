import 'ioredis'

declare module 'ioredis' {
  interface Commands {
    xautoclaim: OverloadedKeyCommand<ValueType, Array<[string, string[]]>>;
  }
}
