import { createSimpleContext } from "@opencode-ai/ui/context"
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { useSettings } from "./settings"
import { useServerSDK } from "./server-sdk"
import { useServer } from "./server"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import { type DraftTab, useTabs } from "./tabs"
import { requireServerKey } from "@/utils/session-route"
import type { ServerScope } from "@/utils/server-scope"

interface WebPushState {
  supported: boolean
  permission: NotificationPermission
  subscribed: boolean
  loading: boolean
  error: string | null
}

interface WebPushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

const VAPID_PUBLIC_KEY_KEY = "webpush:vapidPublicKey"
const SUBSCRIPTION_KEY = "webpush:subscription"

export function isWebPushSupported(): boolean {
  if (typeof navigator === "undefined") return false
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
}

export function getServerScopeFromConnection(conn: ServerConnection.Any): ServerScope {
  return conn.type === "http" ? conn.http.url : conn.type
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

export const { use: useWebPush, provider: WebPushProvider } = createSimpleContext({
  name: "WebPush",
  gate: false,
  init: () => {
    const language = useLanguage()
    const platform = usePlatform()
    const settings = useSettings()
    const global = useGlobal()
    const server = useServer()
    const tabs = useTabs()

    const params = useParams<{ serverKey?: string; dir?: string; id?: string }>()
    const [search] = useSearchParams<{ draftId?: string }>()

    const activeServer = createMemo(() => {
      if (params.serverKey) return requireServerKey(params.serverKey)
      if (search.draftId) {
        const draft = tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId)
        if (draft) return draft.server
      }
      return server.key
    })

    const [state, setState] = createSignal<WebPushState>({
      supported: isWebPushSupported(),
      permission: typeof Notification !== "undefined" ? Notification.permission : "default",
      subscribed: false,
      loading: false,
      error: null,
    })

    const serverSDK = createMemo(() => {
      const conn = global.servers.list().find((s) => ServerConnection.key(s) === activeServer())
      if (!conn) throw new Error(language.t("error.webpush.noServer"))
      return global.ensureServerCtx(conn).sdk
    })

    const checkExistingSubscription = async (): Promise<void> => {
      if (!state().supported) return
      try {
        const registration = await navigator.serviceWorker.ready
        const subscription = await registration.pushManager.getSubscription()
        if (subscription) {
          const sub: WebPushSubscription = {
            endpoint: subscription.endpoint,
            keys: {
              p256dh: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey("p256dh")!))),
              auth: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey("auth")!))),
            },
          }
          setState((prev) => ({ ...prev, subscribed: true }))
        }
      } catch {
        // Ignore errors
      }
    }

    const fetchVAPIDPublicKey = async (): Promise<string> => {
      const sdk = serverSDK()
      const response = await sdk.client.webpush.getVapid()
      return response.data.publicKey
    }

    const registerServiceWorker = async (): Promise<ServiceWorkerRegistration> => {
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" })
      await navigator.serviceWorker.ready
      return registration
    }

    const subscribe = async (): Promise<void> => {
      if (!state().supported) {
        setState((prev) => ({ ...prev, error: language.t("error.webpush.notSupported") }))
        return
      }

      setState((prev) => ({ ...prev, loading: true, error: null }))

      try {
        const permission = Notification.permission === "default"
          ? await Notification.requestPermission().catch(() => "denied" as NotificationPermission)
          : Notification.permission

        if (permission !== "granted") {
          setState((prev) => ({ ...prev, permission, loading: false, error: language.t("error.webpush.permissionDenied") }))
          return
        }

        setState((prev) => ({ ...prev, permission }))

        await registerServiceWorker()

        const vapidPublicKey = await fetchVAPIDPublicKey()
        const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey)

        const registration = await navigator.serviceWorker.ready
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        })

        const sub: WebPushSubscription = {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey("p256dh")!))),
            auth: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey("auth")!))),
          },
        }

        const installationID = localStorage.getItem("opencode:installationID") || crypto.randomUUID()
        localStorage.setItem("opencode:installationID", installationID)

        const sdk = serverSDK()
        await sdk.client.webpush.upsertSubscription({
          id: installationID,
          endpoint: sub.endpoint,
          keys: sub.keys,
        })

        setState((prev) => ({ ...prev, subscribed: true, loading: false }))
      } catch (error) {
        const message = error instanceof Error ? error.message : language.t("error.webpush.subscribeFailed")
        setState((prev) => ({ ...prev, loading: false, error: message }))
      }
    }

    const unsubscribe = async (): Promise<void> => {
      if (!state().supported || !state().subscribed) return

      setState((prev) => ({ ...prev, loading: true, error: null }))

      try {
        const installationID = localStorage.getItem("opencode:installationID")
        if (installationID) {
          const sdk = serverSDK()
          await sdk.client.webpush.removeSubscription({ id: installationID })
        }

        const registration = await navigator.serviceWorker.ready
        const subscription = await registration.pushManager.getSubscription()
        if (subscription) {
          await subscription.unsubscribe()
        }

        setState((prev) => ({ ...prev, subscribed: false, loading: false }))
      } catch (error) {
        const message = error instanceof Error ? error.message : language.t("error.webpush.unsubscribeFailed")
        setState((prev) => ({ ...prev, loading: false, error: message }))
      }
    }

    const toggle = async (): Promise<void> => {
      if (state().subscribed) {
        await unsubscribe()
      } else {
        await subscribe()
      }
    }

    onMount(() => {
      checkExistingSubscription()
      navigator.serviceWorker.addEventListener("controllerchange", checkExistingSubscription)
    })

    onCleanup(() => {
      navigator.serviceWorker.removeEventListener("controllerchange", checkExistingSubscription)
    })

    const categoryEnabled = createMemo(() => settings.notifications.permissions())
    const shouldShowToggle = createMemo(() => state().supported && categoryEnabled())

    return {
      get state() {
        return state()
      },
      supported: createMemo(() => state().supported),
      permission: createMemo(() => state().permission),
      subscribed: createMemo(() => state().subscribed),
      loading: createMemo(() => state().loading),
      error: createMemo(() => state().error),
      categoryEnabled,
      shouldShowToggle,
      subscribe,
      unsubscribe,
      toggle,
    }
  },
})