/** In-memory now; Workers would use the Cache API behind the same interface. */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T, ttlSec: number): Promise<void>
}

export function memoryCache(now: () => number = Date.now): Cache {
  const entries = new Map<string, { value: unknown; expires: number }>()
  return {
    async get<T>(key: string) {
      const e = entries.get(key)
      if (!e) return undefined
      if (e.expires <= now()) {
        entries.delete(key)
        return undefined
      }
      return e.value as T
    },
    async set<T>(key: string, value: T, ttlSec: number) {
      entries.set(key, { value, expires: now() + ttlSec * 1000 })
    },
  }
}
