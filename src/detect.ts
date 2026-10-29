export type ProxySource = "windows" | "environment" | "manual" | "none"

export interface DetectedProxy {
  enabled: boolean
  source: ProxySource
  httpProxy?: string
  httpsProxy?: string
  noProxy: string[]
  autoConfigURL?: string
  warnings: string[]
}

const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"]

export function loopbackBypass(): string[] {
  return [...LOOPBACK]
}

/**
 * Merge several NO_PROXY style lists, dropping empties and duplicates.
 */
export function mergeNoProxy(...lists: (readonly string[] | undefined)[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const list of lists) {
    if (!list) continue
    for (const entry of list) {
      const value = entry.trim()
      if (!value) continue
      const key = value.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      result.push(value)
    }
  }
  return result
}

export interface WindowsProxyServer {
  http?: string
  https?: string
  ftp?: string
  socks?: string
  all?: string
}

/**
 * Windows stores either a single `host:port` or a per-scheme list such as
 * `http=host:port;https=host:port;socks=host:port`.
 */
export function parseWindowsProxyServer(raw: string): WindowsProxyServer {
  const value = raw.trim()
  if (!value) return {}
  if (!value.includes("=")) return { all: value }

  const result: WindowsProxyServer = {}
  for (const part of value.split(";")) {
    const separator = part.indexOf("=")
    if (separator === -1) continue
    const scheme = part.slice(0, separator).trim().toLowerCase()
    const address = part.slice(separator + 1).trim()
    if (!address) continue
    if (scheme === "http" || scheme === "https" || scheme === "ftp" || scheme === "socks") {
      result[scheme] = address
    }
  }
  return result
}

/**
 * Windows bypass list uses `;` and WinINET wildcards. Translate what Bun's
 * NO_PROXY understands: `*.example.com`, single IPs and simple `10.*` ranges.
 */
export function parseWindowsProxyOverride(raw: string): string[] {
  return raw
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    // `<local>` means "names without a dot"; NO_PROXY cannot express it, and
    // loopback is always bypassed by the plugin anyway.
    .filter((entry) => entry.toLowerCase() !== "<local>")
    .map(toNoProxyEntry)
}

function toNoProxyEntry(entry: string): string {
  if (entry === "*") return entry
  if (!entry.includes("*")) return entry

  const parts = entry.split(".")
  const fixed = parts.slice(0, -1)
  if (parts.at(-1) !== "*" || fixed.length === 0) return entry
  if (!fixed.every((part) => /^\d+$/.test(part))) return entry

  const bits = fixed.length * 8
  if (bits > 32) return entry
  const octets = [...fixed, ...Array(4 - fixed.length).fill("0")]
  return `${octets.join(".")}/${bits}`
}

const SOCKS_SCHEMES = new Set(["socks:", "socks4:", "socks5:", "socks5h:", "socks4a:"])

/**
 * Normalize a proxy address from the registry into a URL Bun accepts.
 */
export function normalizeProxyUrl(raw: string | undefined): { url?: string; warning?: string } {
  if (!raw) return {}
  let value = raw.trim()
  if (!value) return {}
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { warning: `Ignoring unparseable proxy address "${raw}"` }
  }

  if (SOCKS_SCHEMES.has(url.protocol)) {
    return {
      warning: `Ignoring SOCKS proxy "${raw}": Bun's fetch only supports HTTP(S) proxies. Set the "proxy" option to an HTTP proxy instead.`,
    }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { warning: `Ignoring proxy "${raw}" with unsupported scheme "${url.protocol}"` }
  }
  if (!url.hostname) return { warning: `Ignoring proxy "${raw}" without a host` }

  return { url: value.replace(/\/+$/, "") }
}

export function maskProxyUrl(value: string): string {
  if (!value.includes("://") || !value.includes("@")) return value
  try {
    const url = new URL(value)
    if (!url.username && !url.password) return value
    url.username = url.username ? "***" : ""
    url.password = url.password ? "***" : ""
    return url.toString().replace(/\/$/, "")
  } catch {
    return value
  }
}

function unique(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

export interface WindowsInternetSettings {
  /** REG_DWORD as a number. */
  ProxyEnable?: number | string
  ProxyServer?: string
  ProxyOverride?: string
  AutoConfigURL?: string
}

/**
 * Turn the WinINET values into proxy settings.
 */
export function parseWindowsSettings(values: WindowsInternetSettings): DetectedProxy {
  const bypass = mergeNoProxy(loopbackBypass(), parseWindowsProxyOverride(values.ProxyOverride ?? ""))
  const autoConfigURL = values.AutoConfigURL?.trim() || undefined
  const enabled =
    typeof values.ProxyEnable === "number"
      ? values.ProxyEnable !== 0
      : /^(0x)?1$/i.test((values.ProxyEnable ?? "").trim())
  const warnings: string[] = []

  if (!enabled) {
    if (autoConfigURL) {
      warnings.push(
        `Windows auto-config script (PAC) is enabled (${autoConfigURL}) but PAC is not supported. Set the "proxy" option to an HTTP proxy to route through it.`,
      )
    }
    return { enabled: false, source: "windows", noProxy: bypass, autoConfigURL, warnings }
  }

  const servers = parseWindowsProxyServer(values.ProxyServer ?? "")
  const http = pickProxy([servers.http, servers.https, servers.all], warnings)
  const https = pickProxy([servers.https, servers.http, servers.all], warnings)

  if (!http && !https) {
    if (!warnings.length) {
      warnings.push("Windows reports an enabled proxy but no HTTP proxy address is configured.")
    }
    return { enabled: false, source: "windows", noProxy: bypass, autoConfigURL, warnings: unique(warnings) }
  }

  return {
    enabled: true,
    source: "windows",
    httpProxy: http,
    httpsProxy: https,
    noProxy: bypass,
    autoConfigURL,
    warnings: unique(warnings),
  }
}

function pickProxy(candidates: (string | undefined)[], warnings: string[]): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue
    const normalized = normalizeProxyUrl(candidate)
    if (normalized.warning) {
      warnings.push(normalized.warning)
      continue
    }
    if (normalized.url) return normalized.url
  }
  return undefined
}

export function detectFromEnvironment(env: NodeJS.ProcessEnv = process.env): DetectedProxy {
  const https = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy
  const http = env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy
  const bypass = (env.NO_PROXY || env.no_proxy || "").split(/[,\s]+/)

  const httpProxy = normalizeProxyUrl(http)
  const httpsProxy = normalizeProxyUrl(https)

  return {
    enabled: Boolean(httpProxy.url || httpsProxy.url),
    source: "environment",
    httpProxy: httpProxy.url,
    httpsProxy: httpsProxy.url,
    noProxy: mergeNoProxy(loopbackBypass(), bypass),
    warnings: unique([httpProxy.warning, httpsProxy.warning]),
  }
}
