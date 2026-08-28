import { WebPush } from "@opencode-ai/core/web-push"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const WebPushHandler = HttpApiBuilder.group(Api, "server.webpush", (handlers) =>
  Effect.gen(function* () {
    const webpush = yield* WebPush.Service

    return handlers
      .handle(
        "webpush.vapid.get",
        Effect.fn(function* () {
          const publicKey = yield* webpush.getVAPIDPublicKey()
          return { data: { publicKey } }
        }),
      )
      .handle(
        "webpush.subscription.upsert",
        Effect.fn(function* (ctx) {
          const subscription = yield* webpush.upsertSubscription(ctx.payload)
          return { data: subscription }
        }),
      )
      .handle(
        "webpush.subscription.remove",
        Effect.fn(function* (ctx) {
          yield* webpush.removeSubscription(ctx.params.id)
          return { data: { success: true } }
        }),
      )
  }),
)
