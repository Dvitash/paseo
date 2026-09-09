// No fetch handler or app-shell cache: installing push must not freeze an old UI build.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function registeredServerId() {
  const path = new URL(self.registration.scope).pathname;
  const match = /^\/_paseo\/push\/([^/]+)\/$/.exec(path);
  return match ? decodeURIComponent(match[1]) : "";
}

function workspaceSegment(workspaceId) {
  if (/^[A-Za-z0-9._~-]+$/.test(workspaceId)) return workspaceId;
  // Match host-routes.ts, including legacy path-shaped workspace IDs.
  const bytes = new TextEncoder().encode(workspaceId);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `b64_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function notificationRoute(data) {
  // The registration, not a remote payload, owns which paired host is opened.
  const serverId = registeredServerId();
  if (!serverId) return "/";
  const hostRoute = `/h/${encodeURIComponent(serverId)}`;
  const workspaceId = readString(data?.workspaceId);
  if (!workspaceId) return hostRoute;
  const agentId = readString(data?.agentId);
  const terminalId = readString(data?.terminalId);
  let target = "";
  if (agentId) target = `agent:${agentId}`;
  else if (terminalId) target = `terminal:${terminalId}`;
  if (!target) return hostRoute;
  return `${hostRoute}/workspace/${encodeURIComponent(workspaceSegment(workspaceId))}?open=${encodeURIComponent(target)}`;
}

async function showPush(event) {
  let payload = {};
  try {
    const parsed = event.data?.json();
    if (parsed && typeof parsed === "object") payload = parsed;
  } catch {
    // Even an invalid delivery must remain user-visible (Web Push userVisibleOnly).
  }
  const title = readString(payload.title).slice(0, 200) || "Paseo";
  const body = readString(payload.body).slice(0, 2000) || "An agent needs your attention.";
  const url = notificationRoute(payload.data);
  await self.registration.showNotification(title, {
    body,
    icon: "/pwa-icon-192.png",
    badge: "/pwa-icon-192.png",
    tag: `paseo:${url}`,
    data: { url },
  });
}

self.addEventListener("push", (event) => {
  event.waitUntil(showPush(event));
});

async function openNotification(notification) {
  notification.close();
  const fallback = notificationRoute(null);
  let target = new URL(fallback, self.location.origin);
  const requested = notification.data?.url;
  if (typeof requested === "string") {
    const candidate = new URL(requested, self.location.origin);
    const hostPrefix = `/h/${encodeURIComponent(registeredServerId())}`;
    const belongsToHost =
      candidate.pathname === hostPrefix || candidate.pathname.startsWith(`${hostPrefix}/`);
    if (candidate.origin === self.location.origin && belongsToHost) target = candidate;
  }
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = windows.find((client) => new URL(client.url).origin === target.origin);
  if (existing) {
    const navigated = await existing.navigate(target.href);
    if (navigated) {
      await navigated.focus();
      return;
    }
  }
  await self.clients.openWindow(target.href);
}

self.addEventListener("notificationclick", (event) => {
  event.waitUntil(openNotification(event.notification));
});
