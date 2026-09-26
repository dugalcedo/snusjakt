// like Promise.all(items.map(fn)), but with at most `limit` calls in flight
export async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length)
    let next = 0

    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++
            results[i] = await fn(items[i]!)
        }
    })

    await Promise.all(workers)
    return results
}
