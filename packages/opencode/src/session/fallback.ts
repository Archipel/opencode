import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { NamedError } from "@opencode-ai/core/util/error"
import { SessionRetry } from "./retry"

export type Err = ReturnType<NamedError["toObject"]>

export const DEFAULT_COOLDOWN_MS = 60_000

const MAX_COOLDOWN_CHAIN = 10

// Process-wide cooldown map: "providerID/modelID" -> epoch ms when the model may be used again.
const cooldowns = new Map<string, number>()

export function ref(providerID: string, modelID: string) {
  return `${providerID}/${modelID}`
}

type FallbackModelConfig = { fallback?: string; fallback_cooldown_ms?: number }

type FallbackProviderConfig = { models?: Record<string, FallbackModelConfig | undefined> | undefined }

export type FallbackConfig = {
  provider?: Record<string, FallbackProviderConfig | undefined> | undefined
}

const RATE_LIMIT_PATTERNS = [/rate.?limit|too many requests|too_many_requests|maximum \d+ requests/i]

/** True when the failure is a rate limit (HTTP 429 or a matching message/body), eligible for fallback. */
export function isRateLimited(error: Err): boolean {
  if (!SessionV1.APIError.isInstance(error)) return false
  if (error.data.statusCode === 429) return true
  const candidates = [error.data.message, error.data.responseBody].filter(
    (value): value is string => typeof value === "string",
  )
  return RATE_LIMIT_PATTERNS.some((pattern) => candidates.some((value) => pattern.test(value)))
}

/** Rate-limit window in ms: Retry-After headers win, then the per-model fallback_cooldown_ms override, then 60s. */
export function cooldownMs(error: Err, config?: FallbackConfig, providerID?: string, modelID?: string): number {
  if (SessionV1.APIError.isInstance(error)) {
    const headers = error.data.responseHeaders
    const retryAfterMs = Number.parseFloat(String(headers?.["retry-after-ms"] ?? ""))
    if (!Number.isNaN(retryAfterMs) && retryAfterMs > 0) return Math.min(retryAfterMs, SessionRetry.RETRY_MAX_DELAY)
    const retryAfter = Number.parseFloat(String(headers?.["retry-after"] ?? ""))
    if (!Number.isNaN(retryAfter) && retryAfter > 0)
      return Math.min(Math.ceil(retryAfter * 1000), SessionRetry.RETRY_MAX_DELAY)
  }
  const override = providerID && modelID ? configOverride(config, providerID, modelID)?.fallback_cooldown_ms : undefined
  return override ?? DEFAULT_COOLDOWN_MS
}

export function markRateLimited(providerID: string, modelID: string, error: Err, config?: FallbackConfig, now = Date.now()) {
  cooldowns.set(ref(providerID, modelID), now + cooldownMs(error, config, providerID, modelID))
}

export function coolingUntil(providerID: string, modelID: string): number | undefined {
  return cooldowns.get(ref(providerID, modelID))
}

export function isCooling(providerID: string, modelID: string, now = Date.now()) {
  const until = cooldowns.get(ref(providerID, modelID))
  return until !== undefined && until > now
}

export type FallbackTarget = { providerID: ProviderV2.ID; modelID: ModelV2.ID }

export function configOverride(config: FallbackConfig | undefined, providerID: string, modelID: string) {
  return config?.provider?.[providerID]?.models?.[modelID]
}

/**
 * When `requested` is cooling down (after a rate limit), walk its configured
 * `fallback` chain and return the first model not cooling. Returns undefined
 * when the requested model is usable, no fallback is configured, or every
 * candidate is cooling.
 */
export function next(
  requested: { providerID: string; modelID: string },
  config: FallbackConfig,
  now = Date.now(),
): FallbackTarget | undefined {
  if (!isCooling(requested.providerID, requested.modelID, now)) return undefined

  const seen = new Set([ref(requested.providerID, requested.modelID)])
  let current = requested
  for (let i = 0; i < MAX_COOLDOWN_CHAIN; i++) {
    const target = config.provider?.[current.providerID]?.models?.[current.modelID]?.fallback
    if (!target) return undefined
    const parsed = ModelV2.parse(target)
    const targetRef = ref(parsed.providerID, parsed.modelID)
    if (seen.has(targetRef)) return undefined
    if (!isCooling(parsed.providerID, parsed.modelID, now)) return parsed
    seen.add(targetRef)
    current = parsed
  }
  return undefined
}

export function clear() {
  cooldowns.clear()
}

export * as SessionFallback from "./fallback"
