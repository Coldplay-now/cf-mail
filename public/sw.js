/* Push-only service worker — no fetch handler, no offline caching. */
self.addEventListener("push", (event) => {
  const data = event.data?.json()?.data ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title || "New mail", {
      body: data.body || "",
      tag: data.tag,
      data: { url: data.url || "/" }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || "/"));
});
