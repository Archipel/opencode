import { describe, expect, test, beforeEach } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionFallback } from "../../src/session/fallback"

const paid = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("paid-model") }
const backup = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("backup-model") }

function apiError(opts: { statusCode?: number; message?: string; headers?: Record<string, string> } = {}) {
  return new SessionV1.APIError({
    message: opts.message ?? "boom",
    isRetryable: opts.statusCode === 429,
    statusCode: opts.statusCode,
    responseHeaders: opts.headers,
  }).toObject()
}

const config = {
  provider: {
    test: {
      models: {
        "free-model": { fallback: "test/paid-model" },
        "paid-model": { fallback: "test/backup-model" },
        "no-fallback": {},
        "cooling-window": { fallback: "test/paid-model", fallback_cooldown_ms: 1234 },
      },
    },
  },
}

beforeEach(() => SessionFallback.clear())

describe("session.fallback.isRateLimited", () => {
  test("detects http 429", () => {
    expect(SessionFallback.isRateLimited(apiError({ statusCode: 429 }))).toBe(true)
  })

  test("detects rate limit messages", () => {
    expect(SessionFallback.isRateLimited(apiError({ message: "Maximum 10 requests per minute reached" }))).toBe(true)
    expect(SessionFallback.isRateLimited(apiError({ message: "Rate limit exceeded" }))).toBe(true)
  })

  test("ignores unrelated errors", () => {
    expect(SessionFallback.isRateLimited(apiError({ statusCode: 500, message: "Internal server error" }))).toBe(false)
    expect(SessionFallback.isRateLimited({ name: "", data: { message: "Maximum 10 requests" } })).toBe(false)
  })
})

describe("session.fallback.cooldownMs", () => {
  test("prefers retry-after-ms headers", () => {
    expect(SessionFallback.cooldownMs(apiError({ statusCode: 429, headers: { "retry-after-ms": "500000" } }))).toBe(
      500000,
    )
  })

  test("prefers retry-after seconds", () => {
    expect(SessionFallback.cooldownMs(apiError({ statusCode: 429, headers: { "retry-after": "60" } }))).toBe(60000)
  })

  test("falls back to configured cooldown window", () => {
    expect(SessionFallback.cooldownMs(apiError({ statusCode: 429 }), config, "test", "cooling-window")).toBe(1234)
  })

  test("defaults to one minute", () => {
    expect(SessionFallback.cooldownMs(apiError({ statusCode: 429 }))).toBe(SessionFallback.DEFAULT_COOLDOWN_MS)
  })
})

describe("session.fallback.next", () => {
  test("returns undefined when the requested model is usable", () => {
    const now = Date.now()
    expect(SessionFallback.next({ providerID: "test", modelID: "free-model" }, config, now)).toBeUndefined()
  })

  test("returns the fallback while the requested model is cooling", () => {
    const now = Date.now()
    const error = apiError({ statusCode: 429 })
    SessionFallback.markRateLimited("test", "free-model", error, config, now)
    expect(SessionFallback.next({ providerID: "test", modelID: "free-model" }, config, now + 1)).toEqual(paid)
  })

  test("skips fallback models that are also cooling", () => {
    const now = Date.now()
    const error = apiError({ statusCode: 429 })
    SessionFallback.markRateLimited("test", "free-model", error, config, now)
    SessionFallback.markRateLimited("test", "paid-model", error, config, now)
    expect(SessionFallback.next({ providerID: "test", modelID: "free-model" }, config, now + 1)).toEqual(backup)
  })

  test("returns undefined without a configured fallback", () => {
    const now = Date.now()
    const error = apiError({ statusCode: 429 })
    SessionFallback.markRateLimited("test", "no-fallback", error, config, now)
    expect(SessionFallback.next({ providerID: "test", modelID: "no-fallback" }, config, now + 1)).toBeUndefined()
  })

  test("resumes the requested model once the cooldown expires", () => {
    const now = Date.now()
    const error = apiError({ statusCode: 429, headers: { "retry-after-ms": "5000" } })
    SessionFallback.markRateLimited("test", "free-model", error, config, now)
    expect(SessionFallback.next({ providerID: "test", modelID: "free-model" }, config, now + 4999)).toEqual(paid)
    expect(SessionFallback.next({ providerID: "test", modelID: "free-model" }, config, now + 5001)).toBeUndefined()
  })
})
