import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { applyProxyEnvironment, currentProxyEnvironment, restoreProxyEnvironment } from "../src/apply.ts"

const NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"] as const
const original = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]))

afterEach(() => {
  restoreProxyEnvironment()
  for (const name of NAMES) {
    const value = original[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test("applyProxyEnvironment sets both cases and the bypass list", () => {
  for (const name of NAMES) delete process.env[name]

  applyProxyEnvironment({
    httpProxy: "http://127.0.0.1:2080",
    httpsProxy: "http://127.0.0.1:2080",
    noProxy: ["localhost", "127.0.0.1"],
  })

  assert.equal(process.env.HTTP_PROXY, "http://127.0.0.1:2080")
  assert.equal(process.env.http_proxy, "http://127.0.0.1:2080")
  assert.equal(process.env.HTTPS_PROXY, "http://127.0.0.1:2080")
  assert.equal(process.env.https_proxy, "http://127.0.0.1:2080")
  assert.equal(process.env.NO_PROXY, "localhost,127.0.0.1")
  assert.equal(process.env.no_proxy, "localhost,127.0.0.1")

  const environment = currentProxyEnvironment()
  assert.equal(environment.HTTPS_PROXY, "http://127.0.0.1:2080")
})

test("restoreProxyEnvironment removes values the plugin added", () => {
  for (const name of NAMES) delete process.env[name]

  applyProxyEnvironment({ httpsProxy: "http://127.0.0.1:2080", noProxy: ["localhost"] })
  restoreProxyEnvironment()

  for (const name of NAMES) assert.equal(process.env[name], undefined, name)
})

test("restoreProxyEnvironment brings back pre-existing values", () => {
  for (const name of NAMES) delete process.env[name]
  process.env.HTTPS_PROXY = "http://corporate:8080"

  applyProxyEnvironment({ httpsProxy: "http://127.0.0.1:2080", noProxy: ["localhost"] })
  assert.equal(process.env.HTTPS_PROXY, "http://127.0.0.1:2080")

  restoreProxyEnvironment()
  assert.equal(process.env.HTTPS_PROXY, "http://corporate:8080")
})

test("applyProxyEnvironment can be called repeatedly without losing the snapshot", () => {
  for (const name of NAMES) delete process.env[name]

  applyProxyEnvironment({ httpsProxy: "http://127.0.0.1:2080", noProxy: ["localhost"] })
  applyProxyEnvironment({ httpsProxy: "http://127.0.0.1:2081", noProxy: ["localhost"] })
  assert.equal(process.env.HTTPS_PROXY, "http://127.0.0.1:2081")

  restoreProxyEnvironment()
  assert.equal(process.env.HTTPS_PROXY, undefined)
})

test("currentProxyEnvironment masks credentials", () => {
  process.env.HTTPS_PROXY = "http://user:secret@proxy:8080"
  assert.equal(currentProxyEnvironment().HTTPS_PROXY, "http://***:***@proxy:8080")
})

