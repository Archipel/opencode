export * as WebPush from "./web-push"

import { Schema } from "effect"
import { optional } from "./schema"
import { define, inventory } from "./event"
import { statics } from "./schema"
import { InstallationID } from "./installation-event"
import { Project } from "./project"

export const VAPIDPublicKey = Schema.String.pipe(Schema.brand("WebPush.VAPIDPublicKey"))
export type VAPIDPublicKey = typeof VAPIDPublicKey.Type

export const VAPIDPrivateKey = Schema.String.pipe(Schema.brand("WebPush.VAPIDPrivateKey"))
export type VAPIDPrivateKey = typeof VAPIDPrivateKey.Type

export const PushSubscriptionKeys = Schema.Struct({
  p256dh: Schema.String,
  auth: Schema.String,
}).annotate({ identifier: "WebPush.PushSubscriptionKeys" })
export type PushSubscriptionKeys = typeof PushSubscriptionKeys.Type

export const PushSubscription = Schema.Struct({
  id: InstallationID,
  endpoint: Schema.String,
  keys: PushSubscriptionKeys,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}).annotate({ identifier: "WebPush.PushSubscription" })
export type PushSubscription = typeof PushSubscription.Type

export const PushPayloadV1 = Schema.Struct({
  version: Schema.Literal(1),
  title: Schema.String,
  body: Schema.String,
  data: Schema.Struct({
    url: Schema.String,
  }),
  tag: Schema.String,
}).annotate({ identifier: "WebPush.PushPayloadV1" })
export type PushPayloadV1 = typeof PushPayloadV1.Type

export const PushPayload = PushPayloadV1
export type PushPayload = typeof PushPayload.Type

const VAPIDKeyPair = Schema.Struct({
  publicKey: VAPIDPublicKey,
  privateKey: VAPIDPrivateKey,
}).annotate({ identifier: "WebPush.VAPIDKeyPair" })
export type VAPIDKeyPair = typeof VAPIDKeyPair.Type

const GetVAPIDKeyResponse = Schema.Struct({
  data: Schema.Struct({ publicKey: VAPIDPublicKey }),
}).annotate({ identifier: "WebPush.GetVAPIDKeyResponse" })
export type GetVAPIDKeyResponse = typeof GetVAPIDKeyResponse.Type

const UpsertSubscriptionInput = Schema.Struct({
  id: InstallationID,
  endpoint: Schema.String,
  keys: PushSubscriptionKeys,
}).annotate({ identifier: "WebPush.UpsertSubscriptionInput" })
export type UpsertSubscriptionInput = typeof UpsertSubscriptionInput.Type

const UpsertSubscriptionResponse = Schema.Struct({
  data: PushSubscription,
}).annotate({ identifier: "WebPush.UpsertSubscriptionResponse" })
export type UpsertSubscriptionResponse = typeof UpsertSubscriptionResponse.Type

const RemoveSubscriptionResponse = Schema.Struct({
  data: Schema.Struct({ success: Schema.Boolean }),
}).annotate({ identifier: "WebPush.RemoveSubscriptionResponse" })
export type RemoveSubscriptionResponse = typeof RemoveSubscriptionResponse.Type

const PushEvent = define({
  type: "webpush.notification",
  schema: {
    subscriptionID: InstallationID,
    payload: PushPayload,
  },
})
export const Event = { Push: PushEvent, Definitions: inventory(PushEvent) }