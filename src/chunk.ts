export function chunk<T>(array: T[], size: number): T[][] {
  const result: T[][] = []

  for (let x = 0; x < Math.ceil(array.length / size); x++) {
    const start = x * size
    const end = start + size

    result.push(array.slice(start, end))
  }

  return result
}
