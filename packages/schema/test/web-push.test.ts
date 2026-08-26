import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { WebPush } from "../src/web-push"

describe("Web Push contracts", () => {
  it("accepts a browser subscription without private VAPID material", () => {
    const input = Schema.decodeUnknownSync(WebPush.UpsertSubscriptionInput)({
      id: "installation-1",
      endpoint: "https://push.example.test/subscription",
      keys: { p256dh: "public", auth: "auth" },
    })

    expect(input.endpoint).toBe("https://push.example.test/subscription")
    expect("VAPIDPrivateKey" in WebPush).toBe(false)
  })

  it("keeps the notification payload privacy-safe", () => {
    const payload = Schema.decodeUnknownSync(WebPush.PushPayload)({
      version: 1,
      title: "OpenCode permission request",
      body: "OpenCode is waiting for your approval",
      data: { url: "/" },
      tag: "opencode-permission",
    })

    expect(payload.data.url).toBe("/")
  })
})
