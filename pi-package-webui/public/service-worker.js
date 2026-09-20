const CACHE_NAME = "pi-webui-pwa-v155";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/issue-wizard-state.mjs",
  "/issue-bot-client.mjs",
  "/mobile-shell-state.mjs",
  "/aur-review-payload.mjs",
  "/guided-git-command-state.mjs",
  "/guided-git-review-state.mjs",
  "/fast-output-live.mjs",
  "/stream-output-controller.mjs",
  "/stream-derived-output.mjs",
  "/stream-markdown-tail.mjs",
  "/stream-render-scheduler.mjs",
  "/middle-button-drag-scroll.mjs",
  "/theme-contract.mjs",
  "/sampling-parameter-controls.mjs",
  "/transcript-renderer.mjs",
  "/syntax-highlight.mjs",
  "/subagent-launch-slot-state.mjs",
  "/subagent-gate-visibility.mjs",
  "/workflow-status-stack.mjs",
  "/voice-conversation.mjs",
  "/favicon.svg",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/catppuccin-mocha-background.png",
  "/matrix-background.webp",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

const OPAQUE_TARGET_ID = /^[A-Za-z0-9_-]{8,128}$/;
const MOBILE_NAVIGATION_MESSAGE_TYPE = "pi-webui:navigate:v1";

function notificationTarget(data) {
  const target = data?.target;
  if (!target || target.v !== 1 || !["chat", "sessions", "activity", "project"].includes(target.route)) return null;
  const normalized = { v: 1, route: target.route };
  for (const key of ["tabId", "runId", "blockerId"]) {
    if (typeof target[key] === "string" && OPAQUE_TARGET_ID.test(target[key])) normalized[key] = target[key];
  }
  return Object.keys(normalized).length > 2 ? normalized : null;
}

function notificationTargetUrl(data) {
  const target = notificationTarget(data);
  if (!target) return `${self.location.origin}/`;
  const url = new URL("/", self.location.origin);
  url.searchParams.set("mobileRoute", target.route);
  if (target.tabId) url.searchParams.set("tab", target.tabId);
  if (target.runId) url.searchParams.set("run", target.runId);
  if (target.blockerId) url.searchParams.set("blocker", target.blockerId);
  return url.href;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = notificationTarget(event.notification.data);
  const targetUrl = notificationTargetUrl(event.notification.data);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const webuiClient = clients.find((client) => client.url.startsWith(self.location.origin));
      if (webuiClient) {
        return webuiClient.focus().then((client) => {
          if (target) client.postMessage({ type: MOBILE_NAVIGATION_MESSAGE_TYPE, target });
          return client;
        });
      }
      return self.clients.openWindow?.(targetUrl);
    }),
  );
});

// Network-first keeps the app shell fresh after deploys regardless of
// CACHE_NAME or ?v= cache-buster drift; the cache only serves offline clients.
// A bounded request prevents a stalled browser network service from blocking
// startup forever. Cache writes extend the event lifetime without delaying a
// usable network response, so a stalled CacheStorage service cannot block boot.
const APP_SHELL_NETWORK_TIMEOUT_MS = 8_000;

function fetchWithTimeout(request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APP_SHELL_NETWORK_TIMEOUT_MS);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timeout));
}

function fetchThenCache(event) {
  const { request } = event;
  const networkResponse = fetchWithTimeout(request);
  event.waitUntil(
    networkResponse
      .then((response) => {
        if (!response.ok) return undefined;
        return caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
      })
      .catch(() => undefined),
  );
  return networkResponse;
}

// ignoreSearch lets precached bare paths satisfy ?v= cache-busted requests offline.
function cachedAppShell(request, fallbackPath) {
  return caches.match(request, { ignoreSearch: true }).then((cached) => {
    if (cached || !fallbackPath) return cached;
    return caches.match(fallbackPath, { ignoreSearch: true });
  });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetchThenCache(event).catch(() => cachedAppShell(request, "/index.html")));
    return;
  }

  if (!APP_SHELL.includes(url.pathname)) return;
  event.respondWith(fetchThenCache(event).catch(() => cachedAppShell(request)));
});
