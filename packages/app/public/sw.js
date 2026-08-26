const APP_URL = new URL("/", self.location.origin).href

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification("OpenCode permission request", {
      body: "OpenCode is waiting for your approval",
      icon: "/favicon-96x96.png",
      badge: "/favicon-96x96.png",
      tag: "opencode-permission",
      data: { url: APP_URL },
      requireInteraction: true,
    }),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const app = clients.find((client) => new URL(client.url).origin === self.location.origin)
      if (app && "focus" in app) return app.focus()
      return self.clients.openWindow(APP_URL)
    }),
  )
})
