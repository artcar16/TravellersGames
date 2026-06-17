/* ============================================================
   github.js — Persistance de la base de données dans des
   fichiers .md du dépôt GitHub, via l'API REST Contents.

   GitHub Pages est un hébergement STATIQUE : impossible d'écrire
   un fichier côté serveur. La solution standard est de laisser le
   NAVIGATEUR committer les fichiers via l'API GitHub, authentifié
   par un Personal Access Token (PAT) saisi par l'organisateur.

   - Lecture publique : aucun token nécessaire (raw.githubusercontent).
   - Écriture : token requis (scope « repo » fine-grained: Contents RW).

   Le token est stocké uniquement dans le localStorage du navigateur
   de l'organisateur ; il n'est jamais commité.
   ============================================================ */
(function () {
  "use strict";

  const CFG_KEY = "tg_github_cfg_v1";
  const API = "https://api.github.com";

  let cfg = { owner: "", repo: "", branch: "main", path: "data", token: "" };
  let syncTimer = null;
  let status = "local"; // local | syncing | connected | error
  const statusListeners = [];

  function load() {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      if (raw) cfg = Object.assign(cfg, JSON.parse(raw));
    } catch (e) {}
    // Auto-détection owner/repo depuis l'URL GitHub Pages.
    if ((!cfg.owner || !cfg.repo) && location.hostname.endsWith("github.io")) {
      cfg.owner = cfg.owner || location.hostname.split(".")[0];
      const seg = location.pathname.split("/").filter(Boolean);
      if (seg.length && !cfg.repo) cfg.repo = seg[0];
    }
    return cfg;
  }

  function save(patch) {
    cfg = Object.assign(cfg, patch || {});
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    setStatus(cfg.token && cfg.owner && cfg.repo ? "connected" : "local");
  }

  function getConfig() { return Object.assign({}, cfg); }
  function isConfigured() { return !!(cfg.owner && cfg.repo && cfg.token); }
  function canRead() { return !!(cfg.owner && cfg.repo); }

  function onStatus(fn) { statusListeners.push(fn); }
  function setStatus(s) { status = s; statusListeners.forEach((fn) => fn(s)); }
  function getStatus() { return status; }

  function headers(json) {
    const h = { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (cfg.token) h["Authorization"] = "Bearer " + cfg.token;
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  function b64encode(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }
  function b64decode(b64) {
    return decodeURIComponent(escape(atob(b64.replace(/\n/g, ""))));
  }

  // ---- Lecture d'un fichier (renvoie {content, sha} ou null) ----
  async function getFile(path) {
    const url = `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${encodeURIComponent(cfg.branch)}`;
    const res = await fetch(url, { headers: headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("GET " + path + " → " + res.status);
    const data = await res.json();
    return { content: b64decode(data.content), sha: data.sha };
  }

  // ---- Écriture (création ou maj) d'un fichier ----
  async function putFile(path, content, message) {
    let sha = null;
    try { const existing = await getFile(path); if (existing) sha = existing.sha; } catch (e) {}
    const url = `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${path}`;
    const body = {
      message: message || ("maj " + path),
      content: b64encode(content),
      branch: cfg.branch,
    };
    if (sha) body.sha = sha;
    const res = await fetch(url, { method: "PUT", headers: headers(true), body: JSON.stringify(body) });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error("PUT " + path + " → " + res.status + " " + txt);
    }
    return res.json();
  }

  async function deleteFile(path, message) {
    const existing = await getFile(path);
    if (!existing) return;
    const url = `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${path}`;
    const res = await fetch(url, {
      method: "DELETE", headers: headers(true),
      body: JSON.stringify({ message: message || ("suppression " + path), sha: existing.sha, branch: cfg.branch }),
    });
    if (!res.ok) throw new Error("DELETE " + path + " → " + res.status);
  }

  function dataPath(file) { return (cfg.path ? cfg.path.replace(/\/$/, "") + "/" : "") + file; }

  // ---- Sync complète : écrit l'index + un fichier par tournoi ----
  let pendingReason = null;
  function scheduleSync(reason) {
    if (!isConfigured()) return;
    pendingReason = reason;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncNow(pendingReason).catch((e) => console.error(e)); }, 1500);
  }

  async function syncNow(reason) {
    if (!isConfigured()) { setStatus("local"); return { skipped: true }; }
    setStatus("syncing");
    try {
      const db = TG.Store.snapshot();
      // Index
      await putFile(dataPath("index.md"), TG.Store.indexToMarkdown(), "TG: index — " + (reason || ""));
      // Un fichier .md par tournoi
      for (const t of db.tournaments) {
        await putFile(dataPath("tournament-" + t.id + ".md"), TG.Store.tournamentToMarkdown(t),
          "TG: " + t.name + " — " + (reason || ""));
      }
      setStatus("connected");
      return { ok: true };
    } catch (e) {
      console.error(e);
      setStatus("error");
      return { error: e.message };
    }
  }

  // ---- Chargement depuis GitHub ----
  async function pullAll() {
    if (!canRead()) return { error: "Dépôt non configuré." };
    setStatus("syncing");
    try {
      const idx = await getFile(dataPath("index.md"));
      if (!idx) { setStatus(isConfigured() ? "connected" : "local"); return { empty: true }; }
      const m = idx.content.match(/```json\s*([\s\S]*?)```/);
      const ids = m ? (JSON.parse(m[1]).ids || []) : [];
      const tournaments = [];
      for (const id of ids) {
        const f = await getFile(dataPath("tournament-" + id + ".md"));
        if (f) {
          const t = TG.Store.tournamentFromMarkdown(f.content);
          if (t) tournaments.push(t);
        }
      }
      TG.Store.replaceAll({ tournaments });
      setStatus(isConfigured() ? "connected" : "local");
      return { ok: true, count: tournaments.length };
    } catch (e) {
      console.error(e); setStatus("error"); return { error: e.message };
    }
  }

  async function testConnection() {
    if (!cfg.owner || !cfg.repo) return { error: "Renseignez owner/repo." };
    try {
      const url = `${API}/repos/${cfg.owner}/${cfg.repo}`;
      const res = await fetch(url, { headers: headers() });
      if (!res.ok) return { error: "Accès refusé (" + res.status + ")." };
      const data = await res.json();
      return { ok: true, permissions: data.permissions, private: data.private };
    } catch (e) { return { error: e.message }; }
  }

  window.TG = window.TG || {};
  TG.GitHub = {
    load, save, getConfig, isConfigured, canRead,
    onStatus, getStatus,
    getFile, putFile, deleteFile,
    scheduleSync, syncNow, pullAll, testConnection,
  };
})();
