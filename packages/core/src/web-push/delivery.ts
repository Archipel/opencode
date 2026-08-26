export * as WebPushDelivery from "./delivery"

import webPush from "web-push"
import { Context, Effect, Fiber, Layer, Stream } from "effect"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { PermissionV1 } from "../v1/permission"
import { base64Encode } from "../util/encode"
import { WebPush } from "./web-push"
import type { WebPush as WebPushSchema } from "@opencode-ai/schema/web-push"

export interface Interface {
  readonly start: () => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/WebPushDelivery") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const webPushService = yield* WebPush.Service
    const keyPair = yield* webPushService.getVAPIDKeyPair()
    webPush.setVapidDetails("mailto:opencode@opencode.ai", keyPair.publicKey, keyPair.privateKey)

    const deliver = Effect.fnUntraced(function* (request: {
      readonly data: { readonly id: string; readonly sessionID: string }
      readonly location?: { readonly directory: string }
    }) {
      const payload: WebPushSchema.PushPayload = {
        version: 1,
        title: "OpenCode permission request",
        body: "OpenCode is waiting for your approval",
        data: {
          url: request.location
            ? `/${base64Encode(request.location.directory)}/session/${request.data.sessionID}`
            : "/",
        },
        tag: `permission-${request.data.id}`,
      }
      const subscriptions = yield* webPushService.listSubscriptions()
      yield* Effect.forEach(
        subscriptions,
        (subscription) =>
          Effect.tryPromise(() =>
            webPush.sendNotification(
              {
                endpoint: subscription.endpoint,
                keys: subscription.keys,
              },
              JSON.stringify(payload),
              { TTL: 60, urgency: "high" },
            ),
          ).pipe(
            Effect.catch((error) => {
              const statusCode =
                typeof error === "object" &&
                error !== null &&
                "statusCode" in error &&
                typeof error.statusCode === "number"
                  ? error.statusCode
                  : undefined
              if (statusCode === 404 || statusCode === 410) return webPushService.removeSubscription(subscription.id)
              return Effect.logWarning(`Web Push delivery failed: ${error}`)
            }),
          ),
        { concurrency: 5, discard: true },
      )
    })

    const permissionV2 = yield* events.subscribe(PermissionV2.Event.Asked).pipe(
      Stream.runForEach((request) => deliver(request)),
      Effect.forkScoped,
    )
    const permissionV1 = yield* events.subscribe(PermissionV1.Event.Asked).pipe(
      Stream.runForEach((request) => deliver(request)),
      Effect.forkScoped,
    )

    const stop = Effect.fn("WebPushDelivery.stop")(function* () {
      yield* Effect.forEach([permissionV2, permissionV1], Fiber.interrupt, { concurrency: "unbounded", discard: true })
    })
    yield* Effect.addFinalizer(stop)

    return Service.of({ start: () => Effect.void, stop })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [EventV2.node, WebPush.node] })
