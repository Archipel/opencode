// OpenCode Service Worker for Web Push Notifications
// This service worker handles push notifications and navigation clicks.

const CACHE_NAME = "opencode-sw-v1"
const VALID_ORIGINS = new Set([self.location.origin])

function isValidRelativeURL(urlString) {
  try {
    const url = new URL(urlString, self.location.origin)
    return url.origin === self.location.origin && url.pathname.startsWith("/")
  } catch {
    return false
  }
}

function parsePushPayload(data) {
  try {
    const payload = typeof data === "string" ? JSON.parse(data) : data
    if (!payload || typeof payload !== "object") return null
    if (payload.version !== 1) return null
    if (typeof payload.title !== "string" || typeof payload.body !== "string") return null
    if (!payload.data || typeof payload.data.url !== "string") return null
    if (!isValidRelativeURL(payload.data.url)) return null
    if (typeof payload.tag !== "string") return null
    return payload
  } catch {
    return null
  }
}

self.addEventListener("push", (event) => {
  if (!event.data) return

  const payload = parsePushPayload(event.data.json())
  if (!payload) return

  const notificationOptions = {
    body: payload.body,
    icon: "/favicon-96x96.png",
    badge: "/favicon-96x96.png",
    tag: payload.tag,
    data: { url: payload.data.url },
    requireInteraction: true,
    renotify: true,
  }

  event.waitUntil(self.registration.showNotification(payload.title, notificationOptions))
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()

  const url = event.notification.data?.url
  if (!url || !isValidRelativeURL(url)) return

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          return client.focus().then((focusedClient) => {
            if (focusedClient && "navigate" in focusedClient) {
              return focusedClient.navigate(url)
            }
            return focusedClient
          })
        }
      }
      return clients.openWindow(url)
    }),
  )
})

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener("activate", (event) => {
  event.waitUntil(clients.claim())
})

self.addEventListener("fetch", (event) => {
  // No-op for offline caching - we don't cache fetch requests
})