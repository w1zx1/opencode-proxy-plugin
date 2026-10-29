import { Plugin } from "@opencode/plugin"
import { applyProxyEnvironment, currentProxyEnvironment, restoreProxyEnvironment } from "./apply.ts"
import {
  detectFromEnvironment,
  loopbackBypass,
  maskProxyUrl,
  mergeNoProxy,
  normalizeProxyUrl,
  parseWindowsSettings,
  type DetectedProxy,
} from "./detect.ts"
import { loadWindowsSettingsReader, type WindowsSettingsReader } from "./windows.ts"
import { installFetchHook, isHttpRequest } from "./hook.ts"

interface PluginOptions {
  /** "system" (default) reads the OS proxy, "env" only mirrors existing variables, "off" disables the plugin. */
  mode?: "system" | "env" | "off"
  /** Manual proxy override, for example "http://127.0.0.1:2080". Takes precedence over the OS. */
  proxy?: string | { http?: string; https?: string }
  /** Extra NO_PROXY entries, comma or space separated. */
  noProxy?: string | string[]
  /** Expose a `proxy_status` tool. Defaults to true. */
  exposeTool?: boolean
  /** Log every re-read of the OS settings, not only changes. */
  verbose?: boolean
}

interface ResolvedOptions {
  mode: "system" | "env" | "off"
  httpProxy?: string
  httpsProxy?: string
  noProxy: string[]
  exposeTool: boolean
  verbose: boolean
}

type AppliedSettings = DetectedProxy

interface State {
  refs: number
  options: ResolvedOptions
  /** Fast WinINET reader; present only on Windows when bun:ffi is available. */
  reader?: WindowsSettingsReader
  settings?: AppliedSettings
  signature?: string
  timer?: ReturnType<typeof setInterval>
}

const STATE_KEY = Symbol.for("opencode.system-proxy.state")
const LOG_PREFIX = "[system-proxy]"
const WINDOWS_POLL_INTERVAL = 1_000

export default Plugin.define({
  id: "system-proxy",

  async setup(ctx) {
    const reader = await loadWindowsSettingsReader()
    const options = resolveOptions(ctx.options as Record<string, unknown> | undefined)
    const state = acquire(options, reader)
    state.refs += 1

    refresh(state, true)
    ensureTimer(state)

    const releaseFetch =
      state.reader && state.options.mode === "system"
        ? installFetchHook({
            shouldSync: isHttpRequest,
            sync: () => refresh(state, false),
          })
        : () => {}

    if (options.exposeTool) {
      await registerStatusTool(ctx, state).catch((error) => {
        console.error(`${LOG_PREFIX} failed to register the proxy_status tool:`, error)
      })
    }

    return () => {
      releaseFetch()
      state.refs -= 1
      if (state.refs > 0) return

      if (state.timer !== undefined) clearInterval(state.timer)
      restoreProxyEnvironment()

      const holder = globalThis as unknown as Record<symbol, State | undefined>
      if (holder[STATE_KEY] === state) delete holder[STATE_KEY]
    }
  },
})

function acquire(options: ResolvedOptions, reader: WindowsSettingsReader | undefined): State {
  const holder = globalThis as unknown as Record<symbol, State | undefined>
  const existing = holder[STATE_KEY]
  if (existing) {
    // A plugin reload creates a fresh reader; keep it, otherwise the stale one
    // (and its FFI state) survives the reload.
    if (reader) existing.reader = reader
    return existing
  }

  const state: State = { refs: 0, options, reader }
  holder[STATE_KEY] = state
  return state
}

function ensureTimer(state: State): void {
  // Windows reads the registry through FFI in microseconds, so a 1s poll is
  // free. Other platforms have no system proxy detection.
  const interval = process.platform === "win32" ? WINDOWS_POLL_INTERVAL : 0

  if (interval <= 0) {
    if (state.timer !== undefined) clearInterval(state.timer)
    state.timer = undefined
    return
  }

  if (state.timer !== undefined) return

  state.timer = setInterval(() => refresh(state, false), interval)
  // Never keep the server process alive just to poll the registry.
  ;(state.timer as { unref?: () => void } | undefined)?.unref?.()
}

function refresh(state: State, initial: boolean): AppliedSettings {
  const settings = resolveSettings(state)
  const signature = JSON.stringify(settings)

  if (!initial && signature === state.signature) {
    if (state.options.verbose) log("proxy settings unchanged")
    return state.settings ?? settings
  }

  state.signature = signature
  state.settings = settings

  if (settings.enabled) {
    applyProxyEnvironment({
      httpProxy: settings.httpProxy,
      httpsProxy: settings.httpsProxy,
      noProxy: settings.noProxy,
    })
  } else {
    restoreProxyEnvironment()
  }

  logState(settings, initial)
  return settings
}

function resolveSettings(state: State): AppliedSettings {
  const options = state.options
  const bypass = loopbackBypass()
  const extra = options.noProxy

  if (options.mode === "off") {
    return { enabled: false, source: "none", noProxy: mergeNoProxy(bypass, extra), warnings: [] }
  }

  if (options.httpProxy || options.httpsProxy) {
    const http = normalizeProxyUrl(options.httpProxy)
    const https = normalizeProxyUrl(options.httpsProxy ?? options.httpProxy)
    const warnings = [http.warning, https.warning].filter((value): value is string => Boolean(value))
    return {
      enabled: Boolean(http.url || https.url),
      source: "manual",
      httpProxy: http.url,
      httpsProxy: https.url,
      noProxy: mergeNoProxy(bypass, extra, environmentBypass()),
      warnings,
    }
  }

  const detected =
    options.mode === "env"
      ? detectFromEnvironment()
      : state.reader
        ? parseWindowsSettings(state.reader())
        : { enabled: false, source: "windows" as const, noProxy: bypass, warnings: [] }
  return {
    enabled: detected.enabled,
    source: detected.source,
    httpProxy: detected.httpProxy,
    httpsProxy: detected.httpsProxy,
    // Keep the loopback exceptions first: OpenCode talks to its own server over
    // 127.0.0.1, and proxying that traffic breaks the app.
    noProxy: mergeNoProxy(bypass, detected.noProxy, extra, environmentBypass()),
    autoConfigURL: detected.autoConfigURL,
    warnings: detected.warnings,
  }
}

function environmentBypass(): string[] {
  return (process.env.NO_PROXY || process.env.no_proxy || "").split(/[,\s]+/)
}

function logState(settings: AppliedSettings, initial: boolean): void {
  if (!settings.enabled) {
    if (initial) {
      log("no system proxy detected, leaving network requests direct")
    } else {
      log("system proxy disabled, restored the previous environment")
    }
    for (const warning of settings.warnings) log(`warning: ${warning}`)
    return
  }

  const http = settings.httpProxy ? maskProxyUrl(settings.httpProxy) : "-"
  const https = settings.httpsProxy ? maskProxyUrl(settings.httpsProxy) : "-"
  log(`routing HTTP(S) through the ${settings.source} proxy (http=${http}, https=${https})`)
  log(`bypassing proxy for: ${settings.noProxy.join(", ") || "-"}`)

  for (const warning of settings.warnings) log(`warning: ${warning}`)
}

function log(message: string): void {
  // The server logger swallows console.log from plugins; stderr is always kept.
  console.error(`${LOG_PREFIX} ${message}`)
}

async function registerStatusTool(ctx: any, state: State): Promise<void> {
  const transform = ctx?.tool?.transform
  if (typeof transform !== "function") return

  await transform((editor: any) => {
    editor.add({
      name: "proxy_status",
      description:
        "Show the system proxy configuration OpenCode currently uses for outbound HTTP(S) requests, including the effective environment variables.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        const settings = resolveSettings(state)
        return { content: JSON.stringify(describe(state.options, settings, state), null, 2) }
      },
    })
  })
}

function describe(options: ResolvedOptions, settings: AppliedSettings, state: State) {
  return {
    mode: options.mode,
    enabled: settings.enabled,
    source: settings.source,
    registryReader: state.reader ? "advapi32" : null,
    checkBeforeRequest: Boolean(state.reader) && options.mode === "system",
    httpProxy: settings.httpProxy ? maskProxyUrl(settings.httpProxy) : null,
    httpsProxy: settings.httpsProxy ? maskProxyUrl(settings.httpsProxy) : null,
    noProxy: settings.noProxy,
    autoConfigURL: settings.autoConfigURL ?? null,
    pollInterval: process.platform === "win32" ? WINDOWS_POLL_INTERVAL : 0,
    warnings: settings.warnings,
    environment: currentProxyEnvironment(),
  }
}

function resolveOptions(raw: Record<string, unknown> | undefined): ResolvedOptions {
  const input = (raw ?? {}) as PluginOptions
  const mode = input.mode === "env" || input.mode === "off" ? input.mode : "system"

  const proxy = input.proxy
  const httpProxy = typeof proxy === "string" ? proxy : proxy?.http
  const httpsProxy = typeof proxy === "string" ? proxy : (proxy?.https ?? proxy?.http)

  const noProxy =
    typeof input.noProxy === "string"
      ? input.noProxy.split(/[,\s]+/)
      : Array.isArray(input.noProxy)
        ? input.noProxy
        : []

  return {
    mode,
    httpProxy,
    httpsProxy,
    noProxy: noProxy.map((entry) => String(entry).trim()).filter(Boolean),
    exposeTool: input.exposeTool !== false,
    verbose: input.verbose === true,
  }
}
