export type FetchFunction = (input: any, init?: any) => Promise<any>

interface FetchPatch {
  original: FetchFunction
  wrapper: FetchFunction
  refs: number
}

export interface FetchHookOptions {
  /** Return true when this request should refresh the proxy settings first. */
  shouldSync(input: unknown): boolean
  /** Refresh the proxy configuration. Called synchronously before the request. */
  sync(): void
}

const FETCH_KEY = Symbol.for("opencode.system-proxy.fetch-hook")

/**
 * Check the proxy configuration immediately before every matching request.
 *
 * Bun reads HTTP_PROXY/HTTPS_PROXY for each `fetch`, so updating the process
 * environment inside `sync()` makes a proxy switch apply to the very next
 * request instead of waiting for the background poll.
 */
export function installFetchHook(options: FetchHookOptions): () => void {
  const holder = globalThis as unknown as Record<symbol, FetchPatch | undefined>
  const existing = holder[FETCH_KEY]
  if (existing) {
    existing.refs += 1
    return () => release(existing)
  }

  const scope = globalThis as unknown as { fetch: FetchFunction }
  const original = scope.fetch
  if (typeof original !== "function") return () => {}

  const wrapper: FetchFunction = (input, init) => {
    if (options.shouldSync(input)) options.sync()
    return original(input, init)
  }

  // Keep extensions such as fetch.preconnect available.
  for (const key of Object.getOwnPropertyNames(original)) {
    if (key === "length" || key === "name" || key === "prototype") continue
    const descriptor = Object.getOwnPropertyDescriptor(original, key)
    if (descriptor) Object.defineProperty(wrapper, key, descriptor)
  }

  const patch: FetchPatch = { original, wrapper, refs: 1 }
  holder[FETCH_KEY] = patch
  scope.fetch = wrapper

  return () => release(patch)
}

export function isHttpRequest(input: unknown): boolean {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : typeof (input as { url?: unknown })?.url === "string"
          ? (input as { url: string }).url
          : undefined

  return typeof url === "string" && /^https?:\/\//i.test(url)
}

function release(patch: FetchPatch): void {
  patch.refs -= 1
  if (patch.refs > 0) return

  const holder = globalThis as unknown as Record<symbol, FetchPatch | undefined>
  if (holder[FETCH_KEY] === patch) delete holder[FETCH_KEY]

  const scope = globalThis as unknown as { fetch: FetchFunction }
  if (scope.fetch === patch.wrapper) scope.fetch = patch.original
}
