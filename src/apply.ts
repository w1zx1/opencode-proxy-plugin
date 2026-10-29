import { maskProxyUrl } from "./detect.ts"

const VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"] as const
type Variable = (typeof VARIABLES)[number]
type Values = Record<Variable, string | undefined>

const STORE_KEY = Symbol.for("opencode.system-proxy.environment")

interface Snapshot {
  /** Values that were in the environment before the plugin touched it. */
  original: Values
}

export interface ProxyEnvironmentInput {
  httpProxy?: string
  httpsProxy?: string
  noProxy: string[]
}

/**
 * Write the proxy environment variables for the current process.
 *
 * Bun reads HTTP_PROXY/HTTPS_PROXY/NO_PROXY before every fetch, so this covers
 * provider requests, websearch, remote MCP servers and child processes that
 * inherit the environment.
 *
 * The "before" snapshot is stored on globalThis, not in module scope: a plugin
 * reload creates a new module instance, and a module-local snapshot would make
 * the new instance treat the already-applied proxy as user configuration.
 */
export function applyProxyEnvironment(input: ProxyEnvironmentInput): void {
  const holder = globalThis as unknown as Record<symbol, Snapshot | undefined>
  let snapshot = holder[STORE_KEY]

  if (!snapshot) {
    snapshot = { original: readValues() }
    holder[STORE_KEY] = snapshot
  }

  // Both cases are set: Bun accepts either, curl/git and other libraries read lowercase.
  writeValues({
    HTTP_PROXY: input.httpProxy,
    http_proxy: input.httpProxy,
    HTTPS_PROXY: input.httpsProxy,
    https_proxy: input.httpsProxy,
    NO_PROXY: input.noProxy.join(","),
    no_proxy: input.noProxy.join(","),
  })
}

export function restoreProxyEnvironment(): void {
  const holder = globalThis as unknown as Record<symbol, Snapshot | undefined>
  const snapshot = holder[STORE_KEY]
  if (!snapshot) return

  writeValues(snapshot.original)
  delete holder[STORE_KEY]
}

export function currentProxyEnvironment(): Record<Variable, string | null> {
  return Object.fromEntries(
    VARIABLES.map((name) => [name, process.env[name] === undefined ? null : maskProxyUrl(process.env[name] as string)]),
  ) as Record<Variable, string | null>
}

function readValues(): Values {
  return Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]])) as Values
}

function writeValues(values: Values): void {
  for (const name of VARIABLES) {
    const value = values[name]
    if (value === undefined || value === "") delete process.env[name]
    else process.env[name] = value
  }
}
