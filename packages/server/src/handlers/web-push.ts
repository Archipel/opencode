import { WebPush } from "@opencode-ai/core/web-push"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const WebPushHandler = HttpApiBuilder.group(Api, "server.webpush", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "webpush.vapid.get",
        Effect.fn(function* () {
          const webpush = yield* WebPush.Service
          const publicKey = yield* webpush.getVAPIDPublicKey()
          return { data: { publicKey } }
        }),
      )
      .handle(
        "webpush.subscription.upsert",
        Effect.fn(function* (ctx) {
          const webpush = yield* WebPush.Service
          const subscription = yield* webpush.upsertSubscription(ctx.payload)
          return { data: subscription }
        }),
      )
      .handle(
        "webpush.subscription.remove",
        Effect.fn(function* (ctx) {
          const webpush = yield* WebPush.Service
          yield* webpush.removeSubscription(ctx.params.id)
          return { data: { success: true } }
        }),
      )
  }),
)