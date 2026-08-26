const APP_URL = new URL("/", self.location.origin).href

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener("push", (event) => {
  let payload = {}
  try {
    const value = event.data?.json()
    if (value && typeof value === "object") payload = value
  } catch {
    payload = {}
  }
  const title = typeof payload.title === "string" ? payload.title : "OpenCode permission request"
  const body = typeof payload.body === "string" ? payload.body : "OpenCode is waiting for your approval"
  const tag = typeof payload.tag === "string" ? payload.tag : "opencode-permission"
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/favicon-96x96.png",
      badge: "/favicon-96x96.png",
      tag,
      data: { url: sameOriginUrl(payload.data?.url) },
      requireInteraction: true,
    }),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const url = sameOriginUrl(event.notification.data?.url)
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const app = clients.find((client) => new URL(client.url).origin === self.location.origin)
      if (app && "focus" in app) return app.navigate(url).then(() => app.focus())
      return self.clients.openWindow(url)
    }),
  )
})

function sameOriginUrl(value) {
  if (typeof value !== "string") return APP_URL
  try {
    const url = new URL(value, self.location.origin)
    return url.origin === self.location.origin ? url.href : APP_URL
  } catch {
    return APP_URL
  }
}
