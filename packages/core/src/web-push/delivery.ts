export * as WebPushDelivery from "./delivery"

import * as webPush from "web-push"
import { Effect, Fiber, FiberRef, Layer, Option, Queue, Schedule } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { Location } from "../location"
import { makeGlobalNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { PermissionV1 } from "../v1/permission"
import { WebPush, WebPushTable, WebPushVAPIDTable } from "./sql"
import { WebPush as WebPushSchema } from "@opencode-ai/schema/web-push"

const DELIVERY_QUEUE_CAPACITY = 100
const DELIVERY_CONCURRENCY = 5
const MAX_RETRIES = 3
const BASE_RETRY_DELAY_MS = 1000

function makeWebPushClient(vapidKeyPair: WebPushSchema.VAPIDKeyPair): Effect.Effect<webPush.WebPush> {
  return Effect.gen(function* () {
    const client = yield* Effect.sync(() => {
      webPush.setVapidDetails("mailto:opencode@opencode.ai", vapidKeyPair.publicKey, vapidKeyPair.privateKey)
      return webPush
    })
    return client
  })
}

interface DeliveryJob {
  readonly subscription: WebPushSchema.PushSubscription
  readonly payload: WebPushSchema.PushPayload
  readonly attempt: number
}

const currentJob = FiberRef.make<Option.Option<DeliveryJob>>(Option.none())

export interface Interface {
  readonly start: () => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/WebPushDelivery") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const webPushService = yield* WebPush.Service

    const queue = yield* Queue.bounded<DeliveryJob>(DELIVERY_QUEUE_CAPACITY)

    const vapidKeyPair = yield* webPushService.getVAPIDKeyPair()
    const webPushClient = yield* makeWebPushClient(vapidKeyPair)

    const worker = Effect.gen(function* () {
      const job = yield* queue.take
      yield* FiberRef.set(currentJob, Option.some(job))

      const sendNotification = Effect.fnUntraced(function* () {
        const pushSubscription = {
          endpoint: job.subscription.endpoint,
          keys: { p256dh: job.subscription.keys.p256dh, auth: job.subscription.keys.auth },
        }
        const payload = JSON.stringify(job.payload)
        const options: webPush.SendOptions = {
          TTL: 60,
          urgency: "high",
        }
        yield* Effect.tryPromise(() => webPushClient.sendNotification(pushSubscription, payload, options)).pipe(
          Effect.catchTags({
            WebPushError: (error) => {
              const statusCode = error.cause?.statusCode
              if (statusCode === 404 || statusCode === 410) {
                yield* webPushService.removeSubscription(job.subscription.id)
                return Effect.unit
              }
              if (statusCode && statusCode >= 500) {
                return Effect.fail(error)
              }
              return Effect.fail(error)
            },
          }),
        )
      })

      yield* sendNotification.pipe(
        Effect.retry({
          schedule: Schedule.exponential(BASE_RETRY_DELAY_MS).pipe(Schedule.recurs(MAX_RETRIES)),
          while: (error) => {
            const statusCode = error.cause?.statusCode
            return !(statusCode === 404 || statusCode === 410)
          },
        }),
        Effect.catchAll((error) => {
          if (error._tag === "WebPushError" && (error.cause?.statusCode === 404 || error.cause?.statusCode === 410)) {
            return Effect.unit
          }
          return Effect.logError(`Web Push delivery failed after retries: ${error}`)
        }),
      )

      yield* FiberRef.set(currentJob, Option.none())
    }).pipe(Effect.forever, Effect.forkDaemon)

    const workers = yield* Effect.all(Array.from({ length: DELIVERY_CONCURRENCY }, () => worker))

    const handlePermissionAsked = (request: PermissionV2.Request) => {
      const payload: WebPushSchema.PushPayload = {
        version: 1,
        title: "OpenCode needs permission",
        body: "A session is waiting for your approval",
        data: {
          url: `/${location.project.id}/session/${request.sessionID}`,
        },
        tag: `permission-${request.id}`,
      }
      return Effect.gen(function* () {
        const subscriptions = yield* db.select().from(WebPushTable).all().pipe(Effect.orDie)
        yield* Effect.forEach(subscriptions, (sub) => {
          const job: DeliveryJob = {
            subscription: {
              id: sub.id,
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
              timeCreated: sub.time_created,
              timeUpdated: sub.time_updated,
            },
            payload,
            attempt: 0,
          }
          return queue.offer(job).pipe(Effect.catchAll(() => Effect.logWarning("Web Push delivery queue full")))
        }, { concurrency: "unbounded", discard: true })
      })
    }

    const handlePermissionV1Asked = (request: PermissionV1.Request) => {
      const payload: WebPushSchema.PushPayload = {
        version: 1,
        title: "OpenCode needs permission",
        body: "A session is waiting for your approval",
        data: {
          url: `/${location.project.id}/session/${request.sessionID}`,
        },
        tag: `permission-v1-${request.id}`,
      }
      return Effect.gen(function* () {
        const subscriptions = yield* db.select().from(WebPushTable).all().pipe(Effect.orDie)
        yield* Effect.forEach(subscriptions, (sub) => {
          const job: DeliveryJob = {
            subscription: {
              id: sub.id,
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
              timeCreated: sub.time_created,
              timeUpdated: sub.time_updated,
            },
            payload,
            attempt: 0,
          }
          return queue.offer(job).pipe(Effect.catchAll(() => Effect.logWarning("Web Push delivery queue full")))
        }, { concurrency: "unbounded", discard: true })
      })
    }

    const subscriptionFiber = yield* Effect.gen(function* () {
      const sub1 = yield* events.subscribe(PermissionV2.Event.Asked, handlePermissionAsked)
      const sub2 = yield* events.subscribe(PermissionV1.Event.Asked, handlePermissionV1Asked)
      return Effect.all([sub1, sub2], { concurrency: "unbounded" })
    }).pipe(Effect.flatten, Effect.forkDaemon)

    const start = Effect.fn("WebPushDelivery.start")(function* () {
      yield* Effect.logInfo("Web Push delivery service started")
    })

    const stop = Effect.fn("WebPushDelivery.stop")(function* () {
      yield* Fiber.interrupt(subscriptionFiber)
      yield* Effect.forEach(workers, Fiber.interrupt, { concurrency: "unbounded" })
      yield* Effect.logInfo("Web Push delivery service stopped")
    })

    yield* Effect.addFinalizer(() => stop)

    return Service.of({ start, stop })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node, Location.node, WebPush.node] })