import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { installFetchHook, isHttpRequest } from "../src/hook.ts"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("isHttpRequest accepts http(s) strings, URLs and Request-like objects", () => {
  assert.equal(isHttpRequest("http://example.com"), true)
  assert.equal(isHttpRequest("HTTPS://example.com/a"), true)
  assert.equal(isHttpRequest(new URL("https://example.com")), true)
  assert.equal(isHttpRequest({ url: "http://example.com/a" }), true)
  assert.equal(isHttpRequest("file:///tmp/a"), false)
  assert.equal(isHttpRequest("data:text/plain,hi"), false)
  assert.equal(isHttpRequest(undefined), false)
})

test("installFetchHook refreshes before HTTP requests only", async () => {
  const calls: string[] = []
  const original = async (input: any) => {
    calls.push("request")
    return new Response("ok")
  }
  globalThis.fetch = original as unknown as typeof fetch

  let syncs = 0
  const release = installFetchHook({ shouldSync: isHttpRequest, sync: () => void syncs++ })

  try {
    await globalThis.fetch("http://example.com")
    await globalThis.fetch("https://example.com")
    await globalThis.fetch(new URL("https://example.com/a"))
    await globalThis.fetch("file:///tmp/a")
    await globalThis.fetch("data:text/plain,hi")

    assert.equal(calls.length, 5)
    assert.equal(syncs, 3)
  } finally {
    release()
  }
})

test("installFetchHook keeps fetch extensions such as preconnect", async () => {
  const preconnected: string[] = []
  const original = Object.assign(async () => new Response("ok"), {
    preconnect: (url: string) => void preconnected.push(url),
  })
  globalThis.fetch = original as unknown as typeof fetch

  const release = installFetchHook({ shouldSync: isHttpRequest, sync: () => {} })

  try {
    ;(globalThis.fetch as unknown as typeof original).preconnect("https://example.com")
    assert.deepEqual(preconnected, ["https://example.com"])
  } finally {
    release()
  }
})

test("installFetchHook shares one wrapper and restores the original last", async () => {
  const original = async () => new Response("ok")
  globalThis.fetch = original as unknown as typeof fetch

  const releaseFirst = installFetchHook({ shouldSync: isHttpRequest, sync: () => {} })
  const releaseSecond = installFetchHook({ shouldSync: isHttpRequest, sync: () => {} })

  assert.notEqual(globalThis.fetch, original)

  releaseFirst()
  assert.notEqual(globalThis.fetch, original)

  releaseSecond()
  assert.equal(globalThis.fetch, original)
})
