import { createSimpleContext } from "@opencode-ai/ui/context"
import { createMemo, createSignal, onMount } from "solid-js"
import { useGlobal } from "./global"
import { useLanguage } from "./language"
import { useServer } from "./server"
import { useSettings } from "./settings"
import { usePlatform } from "./platform"

interface WebPushState {
  supported: boolean
  permission: NotificationPermission
  subscribed: boolean
  loading: boolean
  error: string | null
}

const INSTALLATION_ID = "opencode:installationID"

export function isWebPushSupported() {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
}

function urlBase64ToUint8Array(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4))
  return Uint8Array.from(raw, (character) => character.charCodeAt(0))
}

function base64Url(value: ArrayBuffer | null) {
  if (!value) throw new Error("Push subscription key is missing")
  return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

export const { use: useWebPush, provider: WebPushProvider } = createSimpleContext({
  name: "WebPush",
  gate: false,
  init: () => {
    const language = useLanguage()
    const settings = useSettings()
    const global = useGlobal()
    const server = useServer()
    const platform = usePlatform()
    const serverSDK = () => {
      if (!server.current) throw new Error(language.t("error.serverSDK.noServerAvailable"))
      return global.ensureServerCtx(server.current).sdk
    }
    const [state, setState] = createSignal<WebPushState>({
      supported: isWebPushSupported() && platform.platform !== "desktop",
      permission: typeof Notification === "undefined" ? "default" : Notification.permission,
      subscribed: false,
      loading: false,
      error: null,
    })

    const readSubscription = async () => {
      if (!state().supported) return
      const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
      setState((current) => ({ ...current, subscribed: subscription !== null }))
    }

    const subscribe = async () => {
      if (!state().supported) {
        setState((current) => ({ ...current, error: language.t("error.webpush.notSupported") }))
        return
      }
      setState((current) => ({ ...current, loading: true, error: null }))
      try {
        const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission
        if (permission !== "granted") {
          setState((current) => ({ ...current, permission, loading: false, error: language.t("error.webpush.permissionDenied") }))
          return
        }
        const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" })
        const vapid = await serverSDK().client.webpush.vapid.get()
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapid.data?.data.publicKey ?? ""),
        })
        const id = localStorage.getItem(INSTALLATION_ID) ?? crypto.randomUUID()
        localStorage.setItem(INSTALLATION_ID, id)
        await serverSDK().client.webpush.subscription.upsert({
          webPushUpsertSubscriptionInput: {
            id,
            endpoint: subscription.endpoint,
            keys: { p256dh: base64Url(subscription.getKey("p256dh")), auth: base64Url(subscription.getKey("auth")) },
          },
        })
        setState((current) => ({ ...current, permission, subscribed: true, loading: false }))
      } catch (error) {
        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : language.t("error.webpush.subscribeFailed"),
        }))
      }
    }

    const unsubscribe = async () => {
      if (!state().supported) return
      setState((current) => ({ ...current, loading: true, error: null }))
      try {
        const id = localStorage.getItem(INSTALLATION_ID)
        if (id) await serverSDK().client.webpush.subscription.remove({ id })
        const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
        if (subscription) await subscription.unsubscribe()
        setState((current) => ({ ...current, subscribed: false, loading: false }))
      } catch (error) {
        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : language.t("error.webpush.unsubscribeFailed"),
        }))
      }
    }

    onMount(() => {
      void readSubscription().catch(() => undefined)
    })
    return {
      state,
      supported: createMemo(() => state().supported),
      subscribed: createMemo(() => state().subscribed),
      loading: createMemo(() => state().loading),
      categoryEnabled: createMemo(() => settings.notifications.permissions()),
      shouldShowToggle: createMemo(() => state().supported && settings.notifications.permissions()),
      toggle: () => (state().subscribed ? unsubscribe() : subscribe()),
    }
  },
})
