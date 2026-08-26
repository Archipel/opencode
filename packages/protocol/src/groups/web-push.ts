import { WebPush } from "@opencode-ai/schema/web-push"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const WebPushGroup = HttpApiGroup.make("server.webpush")
    .add(
      HttpApiEndpoint.get("webpush.vapid.get", "/api/webpush/vapid", {
        success: Schema.Struct({ data: Schema.Struct({ publicKey: WebPush.VAPIDPublicKey }) }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "webpush.vapid.get",
          summary: "Get VAPID public key",
          description: "Retrieve the server's VAPID public key for Web Push subscription.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("webpush.subscription.upsert", "/api/webpush/subscription", {
        payload: WebPush.UpsertSubscriptionInput,
        success: WebPush.UpsertSubscriptionResponse,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "webpush.subscription.upsert",
          summary: "Upsert push subscription",
          description: "Register or update a push subscription for the current installation.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("webpush.subscription.remove", "/api/webpush/subscription/:id", {
        params: { id: WebPush.SubscriptionID },
        success: WebPush.RemoveSubscriptionResponse,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "webpush.subscription.remove",
          summary: "Remove push subscription",
          description: "Remove a push subscription by installation ID.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "Web Push", description: "Web Push notification endpoints." }))
