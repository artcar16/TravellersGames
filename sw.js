/* ============================================================
   sw.js — Coquille hors-ligne (service worker « réseau d'abord »).

   - En ligne : TOUJOURS le réseau (jamais de version périmée) ; une copie
     des fichiers de l'app est gardée au passage.
   - Hors ligne : on sert la dernière copie, pour qu'un téléphone qui
     recharge la page sans réseau garde l'application (ses scores en
     attente partent dès le retour de la connexion).
   - L'API (/api/…) n'est JAMAIS interceptée ni mise en cache.
   ============================================================ */
const CACHE = "tg-shell-v1";

self.addEventListener("install", () => { self.skipWaiting(); });

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  const same = url.origin === self.location.origin;
  if (same && url.pathname.startsWith("/api/")) return;
  const fonts = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!same && !fonts) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === "opaque")) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const c = await caches.open(CACHE);
      const hit = (await c.match(req)) ||
        (req.mode === "navigate" ? ((await c.match("/")) || (await c.match("/index.html"))) : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
