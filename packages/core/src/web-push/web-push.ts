export * as WebPush from "./web-push"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import webPush from "web-push"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { WebPushSubscriptionTable, WebPushVAPIDTable } from "./sql"
import { WebPush } from "@opencode-ai/schema/web-push"

type VAPIDKeyPair = {
  readonly publicKey: WebPush.VAPIDPublicKey
  readonly privateKey: string
}

export const PushSubscription = WebPush.PushSubscription
export type PushSubscription = typeof PushSubscription.Type

export interface Interface {
  readonly getVAPIDKeyPair: () => Effect.Effect<VAPIDKeyPair>
  readonly getVAPIDPublicKey: () => Effect.Effect<WebPush.VAPIDPublicKey>
  readonly upsertSubscription: (input: WebPush.UpsertSubscriptionInput) => Effect.Effect<PushSubscription>
  readonly removeSubscription: (id: WebPush.PushSubscription["id"]) => Effect.Effect<void>
  readonly listSubscriptions: () => Effect.Effect<ReadonlyArray<PushSubscription>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/WebPush") {}

function generateVAPIDKeyPair(): Effect.Effect<VAPIDKeyPair> {
  return Effect.sync(() => {
    const keyPair = webPush.generateVAPIDKeys()
    return { publicKey: keyPair.publicKey as WebPush.VAPIDPublicKey, privateKey: keyPair.privateKey }
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const getVAPIDKeyPair = Effect.fn("WebPush.getVAPIDKeyPair")(function* () {
      const row = yield* db.select().from(WebPushVAPIDTable).where(eq(WebPushVAPIDTable.id, 1)).get().pipe(Effect.orDie)
      if (row) {
        return { publicKey: row.public_key, privateKey: row.private_key }
      }
      const keyPair = yield* generateVAPIDKeyPair()
      const timeCreated = Date.now()
      yield* db
        .insert(WebPushVAPIDTable)
        .values({ id: 1, public_key: keyPair.publicKey, private_key: keyPair.privateKey, time_created: timeCreated })
        .onConflictDoNothing({ target: WebPushVAPIDTable.id })
        .run()
        .pipe(Effect.orDie)
      const persisted = yield* db
        .select()
        .from(WebPushVAPIDTable)
        .where(eq(WebPushVAPIDTable.id, 1))
        .get()
        .pipe(Effect.orDie)
      if (!persisted) return yield* Effect.die("Failed to persist Web Push VAPID key pair")
      return { publicKey: persisted.public_key, privateKey: persisted.private_key }
    })

    const getVAPIDPublicKey = Effect.fn("WebPush.getVAPIDPublicKey")(function* () {
      const keyPair = yield* getVAPIDKeyPair()
      return keyPair.publicKey
    })

    const upsertSubscription = Effect.fn("WebPush.upsertSubscription")(function* (
      input: WebPush.UpsertSubscriptionInput,
    ) {
      const timeNow = Date.now()
      const existing = yield* db
        .select()
        .from(WebPushSubscriptionTable)
        .where(eq(WebPushSubscriptionTable.id, input.id))
        .get()
        .pipe(Effect.orDie)
      if (existing) {
        yield* db
          .update(WebPushSubscriptionTable)
          .set({ endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, time_updated: timeNow })
          .where(eq(WebPushSubscriptionTable.id, input.id))
          .run()
          .pipe(Effect.orDie)
        return {
          id: input.id,
          endpoint: input.endpoint,
          keys: input.keys,
          timeCreated: existing.time_created,
          timeUpdated: timeNow,
        }
      }
      yield* db
        .insert(WebPushSubscriptionTable)
        .values({
          id: input.id,
          endpoint: input.endpoint,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          time_created: timeNow,
          time_updated: timeNow,
        })
        .run()
        .pipe(Effect.orDie)
      return { id: input.id, endpoint: input.endpoint, keys: input.keys, timeCreated: timeNow, timeUpdated: timeNow }
    })

    const removeSubscription = Effect.fn("WebPush.removeSubscription")(function* (id: WebPush.PushSubscription["id"]) {
      yield* db.delete(WebPushSubscriptionTable).where(eq(WebPushSubscriptionTable.id, id)).run().pipe(Effect.orDie)
    })

    const listSubscriptions = Effect.fn("WebPush.listSubscriptions")(function* () {
      const rows = yield* db.select().from(WebPushSubscriptionTable).all().pipe(Effect.orDie)
      return rows.map(
        (row): PushSubscription => ({
          id: row.id,
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
          timeCreated: row.time_created,
          timeUpdated: row.time_updated,
        }),
      )
    })

    return Service.of({ getVAPIDKeyPair, getVAPIDPublicKey, upsertSubscription, removeSubscription, listSubscriptions })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
