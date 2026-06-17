/* ============================================================
   cloud.js — Synchronisation « cloud » de la base de données.

   Remplace l'ancienne synchro GitHub (token personnel dans le
   navigateur). Ici, l'app dialogue avec une fonction serverless
   Vercel (/api/store) adossée à un magasin Redis (Vercel KV).
   La clé secrète reste côté serveur : AUCUN token côté joueur.

   - Au démarrage : sonde /api/store. Si le magasin est configuré,
     l'app passe en mode « cloud » (données partagées par tout le
     monde) ; sinon elle reste en mode « local » (localStorage),
     exactement comme avant.
   - Écriture : à chaque modification, on pousse (en différé) les
     tournois réellement modifiés.
   - Lecture « temps réel » : sondage léger du compteur de révision
     (rev) ; dès qu'il change (quelqu'un d'autre a écrit), on
     recharge l'état et on rafraîchit l'affichage.
   ============================================================ */
(function () {
  "use strict";

  const API = "/api/store";
  const POLL_MS = 7000;       // fréquence de sondage du compteur rev
  const DEBOUNCE_MS = 1200;   // regroupe les écritures rapprochées

  let mode = "local";         // local | cloud
  let status = "local";       // local | syncing | connected | error
  const statusListeners = [];
  let remoteCb = null;        // appelé après application d'un état distant

  let lastRev = 0;
  let lastSynced = {};        // id -> JSON connu côté cloud
  const pendingIds = new Set(); // tournois modifiés localement, pas encore poussés
  let syncTimer = null;
  let pollTimer = null;
  let pushing = false;

  // ---------- Statut ----------
  function setStatus(s) { status = s; statusListeners.forEach((fn) => { try { fn(s); } catch (e) {} }); }
  function onStatus(fn) { statusListeners.push(fn); }
  function getStatus() { return status; }
  function isCloud() { return mode === "cloud"; }
  function onRemoteChange(fn) { remoteCb = fn; }
  function notifyRemote() { if (remoteCb) { try { remoteCb(); } catch (e) {} } }

  // ---------- Appels réseau ----------
  async function getJSON(url) {
    const r = await fetch(url, { cache: "no-store", headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error("GET " + url + " → " + r.status);
    return r.json();
  }
  async function post(body) {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!r.ok) throw new Error("POST → " + r.status);
    return r.json();
  }

  // ---------- Démarrage ----------
  async function init() {
    try {
      const j = await getJSON(API + "?meta=1");
      if (j && j.configured) {
        mode = "cloud";
        lastRev = j.rev || 0;
        setStatus("connected");
      } else {
        mode = "local";
        setStatus("local");
      }
    } catch (e) {
      mode = "local";
      setStatus("local");
    }
    return mode;
  }

  /**
   * Synchro initiale : FUSION non destructive entre local et cloud.
   * - Tournoi présent seulement en local  -> poussé vers le cloud (création).
   * - Tournoi présent seulement dans le cloud -> adopté localement.
   * - Tournoi présent des deux côtés -> on garde le plus récent (updatedAt),
   *   le cloud gagnant par défaut en cas d'égalité.
   * Aucune donnée n'est jamais écrasée en masse : deux navigateurs avec des
   * tournois différents finissent tous les deux avec l'union des tournois.
   */
  async function bootSync() {
    if (mode !== "cloud") return { skipped: true };
    setStatus("syncing");
    try {
      const cloud = await fetchState();
      const cloudById = {};
      (cloud.tournaments || []).forEach((t) => { if (t && t.id) cloudById[t.id] = t; });
      const local = TG.Store.snapshot().tournaments || [];

      const winners = {};                 // id -> version à conserver
      Object.keys(cloudById).forEach((id) => { winners[id] = cloudById[id]; });

      const toPush = [];
      local.forEach((t) => {
        if (!t || !t.id) return;
        const c = cloudById[t.id];
        if (!c || (t.updatedAt || 0) > (c.updatedAt || 0)) { winners[t.id] = t; toPush.push(t); }
      });

      const union = Object.keys(winners).map((id) => winners[id]);
      TG.Store.replaceAll({ tournaments: union });

      // Mémorise l'état « connu du cloud » pour les versions adoptées.
      Object.keys(winners).forEach((id) => { if (toPush.indexOf(winners[id]) === -1) lastSynced[id] = JSON.stringify(winners[id]); });

      // Pousse les créations / versions locales plus récentes.
      for (const t of toPush) {
        const r = await post({ op: "upsert", tournament: t });
        lastSynced[t.id] = JSON.stringify(t);
        if (r && typeof r.rev === "number") lastRev = r.rev;
      }
      if (!toPush.length) lastRev = cloud.rev || lastRev;

      setStatus("connected");
      notifyRemote();
      return { ok: true, merged: union.length, pushed: toPush.length };
    } catch (e) {
      console.error(e);
      setStatus("error");
      return { error: e.message };
    }
  }

  async function fetchState() {
    const j = await getJSON(API);
    return {
      configured: !!j.configured,
      rev: j.rev || 0,
      tournaments: Array.isArray(j.tournaments) ? j.tournaments : [],
    };
  }

  /** Applique un état distant en préservant les éditions locales en cours. */
  function applyRemote(tournaments) {
    const cur = (TG.Store.snapshot().tournaments || []);
    const byId = {};
    (tournaments || []).forEach((t) => { if (t && t.id) byId[t.id] = t; });

    // On ne piétine pas un tournoi en cours d'édition locale non poussée.
    pendingIds.forEach((id) => {
      const localT = cur.find((t) => t.id === id);
      if (localT) byId[id] = localT;
    });

    const merged = Object.keys(byId).map((id) => byId[id]);
    TG.Store.replaceAll({ tournaments: merged });

    // Mémorise ce que le cloud contient (hors tournois en attente de push).
    (tournaments || []).forEach((t) => { if (t && t.id && !pendingIds.has(t.id)) lastSynced[t.id] = JSON.stringify(t); });
    Object.keys(lastSynced).forEach((id) => { if (!byId[id] && !pendingIds.has(id)) delete lastSynced[id]; });

    notifyRemote();
  }

  // ---------- Calcul des changements locaux ----------
  function localDirty() {
    const snap = TG.Store.snapshot();
    const list = snap.tournaments || [];
    const upserts = [];
    list.forEach((t) => {
      if (lastSynced[t.id] !== JSON.stringify(t)) upserts.push(t);
    });
    const present = {};
    list.forEach((t) => { present[t.id] = true; });
    const deletes = Object.keys(lastSynced).filter((id) => !present[id]);
    return { upserts, deletes };
  }

  // ---------- Écriture différée ----------
  function scheduleSync(reason) {
    if (mode !== "cloud") return;
    const { upserts, deletes } = localDirty();
    upserts.forEach((t) => pendingIds.add(t.id));
    deletes.forEach((id) => pendingIds.add(id));
    if (!upserts.length && !deletes.length) return;
    clearTimeout(syncTimer);
    setStatus("syncing");
    syncTimer = setTimeout(() => { pushPending(reason); }, DEBOUNCE_MS);
  }

  async function pushPending(reason) {
    if (mode !== "cloud" || pushing) return;
    pushing = true;
    try {
      const { upserts, deletes } = localDirty();
      for (const t of upserts) {
        const r = await post({ op: "upsert", tournament: t });
        lastSynced[t.id] = JSON.stringify(t);
        pendingIds.delete(t.id);
        if (r && typeof r.rev === "number") lastRev = r.rev;
      }
      for (const id of deletes) {
        const r = await post({ op: "delete", id: id });
        delete lastSynced[id];
        pendingIds.delete(id);
        if (r && typeof r.rev === "number") lastRev = r.rev;
      }
      setStatus("connected");
      return { ok: true };
    } catch (e) {
      console.error(e);
      setStatus("error");
      return { error: e.message };
    } finally {
      pushing = false;
    }
  }

  /** Rechargement manuel depuis le cloud (bouton Réglages). */
  async function pullNow() {
    if (mode !== "cloud") return { error: "Cloud non configuré." };
    setStatus("syncing");
    try {
      const cloud = await fetchState();
      pendingIds.clear();
      lastSynced = {};
      applyRemote(cloud.tournaments);
      lastRev = cloud.rev || lastRev;
      setStatus("connected");
      return { ok: true, count: cloud.tournaments.length };
    } catch (e) {
      setStatus("error");
      return { error: e.message };
    }
  }

  // ---------- Sondage « temps réel » ----------
  async function checkRemote() {
    if (mode !== "cloud" || document.hidden) return;
    try {
      const j = await getJSON(API + "?meta=1");
      const rev = j.rev || 0;
      if (rev !== lastRev) {
        const cloud = await fetchState();
        lastRev = cloud.rev || rev;
        applyRemote(cloud.tournaments);
      }
      if (status === "error") setStatus("connected");
    } catch (e) { /* incident réseau passager : on réessaiera */ }
  }

  function startPolling() {
    if (mode !== "cloud") return;
    stopPolling();
    pollTimer = setInterval(checkRemote, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", checkRemote);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  function onVisible() { if (!document.hidden) checkRemote(); }

  window.TG = window.TG || {};
  TG.Cloud = {
    init, bootSync, isCloud,
    onStatus, getStatus, onRemoteChange,
    scheduleSync, pushPending, pullNow,
    checkRemote, startPolling, stopPolling,
  };
})();
