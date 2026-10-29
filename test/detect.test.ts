import assert from "node:assert/strict"
import { test } from "node:test"
import {
  detectFromEnvironment,
  maskProxyUrl,
  mergeNoProxy,
  normalizeProxyUrl,
  parseWindowsProxyOverride,
  parseWindowsProxyServer,
  parseWindowsSettings,
} from "../src/detect.ts"

test("parseWindowsProxyServer handles a single address", () => {
  assert.deepEqual(parseWindowsProxyServer("127.0.0.1:2080"), { all: "127.0.0.1:2080" })
})

test("parseWindowsProxyServer handles per-scheme addresses", () => {
  assert.deepEqual(parseWindowsProxyServer("http=10.0.0.1:3128;https=10.0.0.2:3129;socks=10.0.0.3:1080"), {
    http: "10.0.0.1:3128",
    https: "10.0.0.2:3129",
    socks: "10.0.0.3:1080",
  })
})

test("parseWindowsProxyOverride converts WinINET patterns", () => {
  assert.deepEqual(parseWindowsProxyOverride("*.local;10.*;192.168.*;<local>;example.com:8080"), [
    "*.local",
    "10.0.0.0/8",
    "192.168.0.0/16",
    "example.com:8080",
  ])
  assert.deepEqual(parseWindowsProxyOverride("*"), ["*"])
})

test("normalizeProxyUrl adds a scheme and rejects SOCKS", () => {
  assert.equal(normalizeProxyUrl("127.0.0.1:2080").url, "http://127.0.0.1:2080")
  assert.equal(normalizeProxyUrl("http://user:pass@proxy:8080/").url, "http://user:pass@proxy:8080")
  assert.match(normalizeProxyUrl("socks5://127.0.0.1:1080").warning ?? "", /SOCKS/)
  assert.match(normalizeProxyUrl("ftp://127.0.0.1:21").warning ?? "", /unsupported scheme/)
  assert.equal(normalizeProxyUrl("").url, undefined)
})

test("maskProxyUrl hides credentials", () => {
  assert.equal(maskProxyUrl("http://user:secret@proxy:8080"), "http://***:***@proxy:8080")
  assert.equal(maskProxyUrl("http://proxy:8080"), "http://proxy:8080")
})

test("mergeNoProxy deduplicates and trims", () => {
  assert.deepEqual(mergeNoProxy(["localhost", " 127.0.0.1 "], ["LOCALHOST", "::1"]), ["localhost", "127.0.0.1", "::1"])
})

test("parseWindowsSettings reads the proxy and bypass list", () => {
  const detected = parseWindowsSettings({
    ProxyEnable: 1,
    ProxyServer: "127.0.0.1:2080",
    ProxyOverride: "<local>;*.corp.local",
  })

  assert.equal(detected.enabled, true)
  assert.equal(detected.httpProxy, "http://127.0.0.1:2080")
  assert.equal(detected.httpsProxy, "http://127.0.0.1:2080")
  assert.ok(detected.noProxy.includes("*.corp.local"))
  assert.ok(!detected.noProxy.includes("<local>"))
})

test("parseWindowsSettings treats a zero ProxyEnable as disabled", () => {
  const detected = parseWindowsSettings({ ProxyEnable: 0, ProxyServer: "127.0.0.1:2080" })
  assert.equal(detected.enabled, false)
})

test("parseWindowsSettings warns about PAC-only setups", () => {
  const detected = parseWindowsSettings({ ProxyEnable: 0, AutoConfigURL: "http://wpad/wpad.dat" })
  assert.equal(detected.enabled, false)
  assert.match(detected.warnings.join(" "), /PAC/)
})

test("detectFromEnvironment reads the standard variables", () => {
  const detected = detectFromEnvironment({
    HTTPS_PROXY: "http://127.0.0.1:3128",
    NO_PROXY: "example.com",
  } as NodeJS.ProcessEnv)

  assert.equal(detected.enabled, true)
  assert.equal(detected.httpsProxy, "http://127.0.0.1:3128")
  assert.ok(detected.noProxy.includes("example.com"))
  assert.ok(detected.noProxy.includes("localhost"))
})
