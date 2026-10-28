"use strict";

// Bump this version whenever an app-shell file changes. A new version waits
// until the user chooses to update or all of the old app's windows close.
const BASE_URL = new URL("./", self.location.href);
const CACHE_PREFIX = `stock-change-calculator:${BASE_URL.pathname}:`;
const CACHE_NAME = `${CACHE_PREFIX}v2`;
const INDEX_URL = new URL("index.html", BASE_URL).href;
const ASSETS = [
  "index.html",
  "styles.css",
  "calculator.js",
  "app.js",
  "pwa.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png"
].map((path) => new URL(path, BASE_URL).href);
const ASSET_URLS = new Set(ASSETS);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) =>
    cache.addAll(ASSETS.map((url) => new Request(url, { cache: "reload" })))));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== BASE_URL.origin) return;

  const isAppNavigation = request.mode === "navigate"
    && (url.pathname === BASE_URL.pathname || url.pathname === new URL(INDEX_URL).pathname);
  const assetUrl = `${url.origin}${url.pathname}`;
  if (!isAppNavigation && !ASSET_URLS.has(assetUrl)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(isAppNavigation ? INDEX_URL : assetUrl);
    return cached || fetch(request);
  })());
});
