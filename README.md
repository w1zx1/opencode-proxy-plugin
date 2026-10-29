# opencode-proxy-plugin

An [OpenCode v2](https://opencode.ai/v2/docs/) plugin that routes all outbound HTTP(S) requests through the
**Windows system proxy** whenever it is enabled. When the proxy is off, requests go direct exactly as before.

No changes to provider settings or `opencode.jsonc` are required — the plugin works at the level of the OpenCode
server process.

## How it works

The OpenCode v2 server is a Bun application, and Bun reads `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` **before every
request**. The plugin therefore:

1. Reads the WinINET proxy settings from
   `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` (`ProxyEnable`, `ProxyServer`, `ProxyOverride`).
2. Sets `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` (upper and lower case) for the server process.
3. Re-reads the settings **right before every HTTP(S) request** and additionally once a second in the background, so
   toggling the system proxy applies to the next request without waiting or restarting. When the proxy is turned off,
   the original environment is restored.

The registry is read directly from `advapi32.dll` (`RegGetValueW` via `bun:ffi`), which takes microseconds and makes
the per-request check free. This is the only code path: if FFI is unavailable, the plugin logs an error and does not
apply a system proxy.

Proxied traffic includes model provider requests, websearch, remote MCP servers, model downloads, and child processes
(`git`, `npm`/`bun`) that inherit the server environment.

`localhost`, `127.0.0.1`, `::1` and `[::1]` are always excluded: OpenCode talks to its own server over loopback, and
that traffic must not be proxied.

## Requirements

- Windows (system proxy detection is Windows-only).
- OpenCode v2 with a Bun-based server (the desktop app and the CLI both qualify).

On other platforms the plugin can still be used with `mode: "env"` to mirror manually configured proxy variables.

## Install

### Option 1 — globally, for all projects

```powershell
.\install.ps1
```

This copies the plugin to `%USERPROFILE%\.config\opencode\plugins\opencode-system-proxy`, where OpenCode discovers
plugins automatically.

Uninstall with `.\install.ps1 -Uninstall`.

### Option 2 — via configuration

Put the plugin directory anywhere and reference it from the global `~/.config/opencode/opencode.jsonc`
(or a project `opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:/Users/you/Downloads/opencode-proxy-plugin"]
}
```

Paths are resolved relative to the config file or taken as absolute.

### After installing

Reload OpenCode with `/reload` in the TUI, or:

```powershell
opencode service restart
```

Look for lines prefixed with `[system-proxy]` in the server stderr (visible with `opencode serve --print-logs` or
`opencode --standalone`). In the desktop app, the `proxy_status` tool is the reliable way to check the state.

## Configuration

Options are passed through the object form of a `plugins` entry:

```jsonc
{
  "plugins": [
    {
      "package": "C:/Users/you/Downloads/opencode-proxy-plugin",
      "options": {
        "proxy": "http://127.0.0.1:2080",
        "noProxy": "*.corp.local,10.0.0.0/8",
        "verbose": true
      }
    }
  ]
}
```

> **Important.** Options only work when the plugin is loaded *through configuration* (option 2). A plugin placed in
> `~/.config/opencode/plugins/` is auto-discovered without options — which is all you need for the default
> "follow the system proxy" behaviour. Do not register the same plugin both in the `plugins/` directory and in the
> `plugins` array: with a double load the options may be lost.

| Option | Default | Description |
| --- | --- | --- |
| `mode` | `"system"` | `"system"` reads the Windows system proxy; `"env"` only mirrors existing environment variables; `"off"` disables the plugin. |
| `proxy` | — | Manual proxy: a string (`"http://host:port"`) or an object `{ "http": "...", "https": "..." }`. Takes precedence over the system settings. Useful for PAC and for authenticated proxies when the system does not supply credentials. |
| `noProxy` | — | Extra exceptions, comma or space separated. Added to the system list and to loopback. |
| `exposeTool` | `true` | Register the `proxy_status` tool that reports the current configuration. |
| `verbose` | `false` | Log every background re-read, not only changes. |

## Verification

The plugin adds a `proxy_status` tool. Ask the agent to call it — it returns the settings source, proxy addresses,
bypass list, warnings, and the effective environment variables:

```json
{
  "mode": "system",
  "enabled": true,
  "source": "windows",
  "registryReader": "advapi32",
  "checkBeforeRequest": true,
  "httpProxy": "http://127.0.0.1:2080",
  "httpsProxy": "http://127.0.0.1:2080",
  "noProxy": ["localhost", "127.0.0.1", "::1", "[::1]"],
  "autoConfigURL": null,
  "pollInterval": 1000,
  "warnings": [],
  "environment": {
    "HTTP_PROXY": "http://127.0.0.1:2080",
    "HTTPS_PROXY": "http://127.0.0.1:2080",
    "NO_PROXY": "localhost,127.0.0.1,::1,[::1]",
    "http_proxy": "http://127.0.0.1:2080",
    "https_proxy": "http://127.0.0.1:2080",
    "no_proxy": "localhost,127.0.0.1,::1,[::1]"
  }
}
```

Credentials are masked in logs and in `proxy_status`.

Additional checks:

```powershell
opencode api get /api/info   # the local service is reachable and was not proxied
```

Enable the proxy, make a model request and check the proxy client logs: connections should come from OpenCode. The
proxy applies to the next request; after turning it off, requests go direct again immediately.

## Limitations

- **PAC / auto-config script** (`AutoConfigURL`) is not supported: resolving a proxy from a JavaScript file is out of
  scope. The plugin logs a warning — set `options.proxy` instead.
- **SOCKS** is not supported by `fetch` in Bun (only HTTP/HTTPS proxies are). If the system proxy is SOCKS, point
  `options.proxy` at the HTTP port of your proxy client (for example Clash's `mixed-port`).
- The plugin configures the **server** process only. TUI/CLI processes and the Electron shell of the desktop app have
  their own settings; Chromium in Electron already uses the system proxy.
- `NO_PROXY` always contains `localhost`, `127.0.0.1`, `::1` — otherwise OpenCode loses its connection to its own
  service.
- Proxy credentials are masked in logs and `proxy_status`, but remain in the process environment.
- The per-request check wraps the global `fetch`. A library that captured a `fetch` reference before the plugin was
  loaded still picks up changes thanks to the background poll (once a second).
- System proxy detection is Windows-only. On other platforms use `mode: "env"` with manually set
  `HTTP_PROXY` / `HTTPS_PROXY`.

## Development

There are no dependencies; tests use the built-in Node test runner:

```powershell
node --test test/detect.test.ts test/apply.test.ts test/hook.test.ts
```

Files:

- `src/detect.ts` — WinINET value parsing, URL normalization and bypass list handling.
- `src/windows.ts` — registry access through `advapi32.dll` (`bun:ffi`).
- `src/apply.ts` — setting and restoring the proxy environment variables.
- `src/hook.ts` — `fetch` wrapper that checks the proxy before every request.
- `src/index.ts` — the plugin itself: settings refresh, logging, `proxy_status` tool.
