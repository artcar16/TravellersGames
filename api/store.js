/* ============================================================
   api/store.js — Base de données « cloud » de The Travellers.

   Fonction serverless Vercel adossée à un magasin Redis
   (Vercel KV / Upstash) via son API REST. La clé secrète reste
   UNIQUEMENT côté serveur (variables d'environnement) : les
   joueurs n'ont aucun token à saisir, tout est partagé.

   Variables d'environnement attendues (injectées par Vercel KV
   ou Upstash lors du branchement du magasin) :
     - KV_REST_API_URL    / UPSTASH_REDIS_REST_URL
     - KV_REST_API_TOKEN  / UPSTASH_REDIS_REST_TOKEN

   Modèle de données Redis :
     - tg:ids        SET des identifiants de tournois
     - tg:t:<id>     STRING (JSON d'un tournoi)
     - tg:rev        compteur incrémenté à chaque écriture
                     (sert au rafraîchissement « temps réel » côté client)

   API :
     GET  /api/store           -> { configured, rev, tournaments }
     GET  /api/store?meta=1     -> { configured, rev }            (sondage léger)
     POST /api/store
          { op:"upsert", tournament }   -> { ok, rev }
          { op:"delete", id }           -> { ok, rev }
          { op:"replaceAll", tournaments } -> { ok, rev }   (migration/import)

   Si aucune variable d'environnement n'est configurée, la fonction
   répond { configured:false } et l'application bascule en mode local.
   ============================================================ */
"use strict";

/**
 * Résout l'URL REST + le token d'écriture du magasin Redis, quel que soit
 * le nommage des variables d'environnement. On gère les noms standards
 * (Vercel KV, Upstash) puis, à défaut, tout couple « *REST*URL » / « *REST*TOKEN »
 * — utile si un préfixe personnalisé a été appliqué lors du branchement.
 * On exclut systématiquement les tokens en lecture seule (READ_ONLY).
 */
function resolveCreds() {
  const env = process.env;
  const known = [
    ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
    ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  ];
  for (const [u, t] of known) {
    if (env[u] && env[t]) return { url: env[u], token: env[t] };
  }
  const keys = Object.keys(env);
  const isHttps = (v) => typeof v === "string" && /^https:\/\//.test(v);
  const urlKey =
    keys.find((k) => /REST.*URL$/i.test(k) && isHttps(env[k])) ||
    keys.find((k) => /URL$/i.test(k) && isHttps(env[k]) && /REDIS|KV|UPSTASH|STORAGE/i.test(k));
  const tokenKey =
    keys.find((k) => /REST.*TOKEN$/i.test(k) && !/READ_ONLY/i.test(k)) ||
    keys.find((k) => /TOKEN$/i.test(k) && !/READ_ONLY/i.test(k) && /REDIS|KV|UPSTASH|STORAGE/i.test(k));
  return { url: urlKey ? env[urlKey] : "", token: tokenKey ? env[tokenKey] : "" };
}

const _creds = resolveCreds();
const REDIS_URL = _creds.url || "";
const REDIS_TOKEN = _creds.token || "";

const K_IDS = "tg:ids";
const K_REV = "tg:rev";
const kT = (id) => "tg:t:" + id;

function configured() {
  return !!(REDIS_URL && REDIS_TOKEN);
}

/** Exécute une pile de commandes Redis via l'API REST pipeline d'Upstash. */
async function redis(commands) {
  const res = await fetch(REDIS_URL.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + REDIS_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error("Redis " + res.status + " " + txt);
  }
  const data = await res.json(); // [{result}|{error}, ...]
  return data.map((d) => {
    if (d && d.error) throw new Error(d.error);
    return d ? d.result : null;
  });
}

function readBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return req.body;
}

function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    if (!configured()) {
      return res.status(200).json({ configured: false });
    }

    // -------- Lecture --------
    if (req.method === "GET") {
      const meta = req.query && (req.query.meta === "1" || req.query.meta === "true");
      if (meta) {
        const [rev] = await redis([["GET", K_REV]]);
        return res.status(200).json({ configured: true, rev: toNum(rev) });
      }
      const [ids, rev] = await redis([["SMEMBERS", K_IDS], ["GET", K_REV]]);
      let tournaments = [];
      if (Array.isArray(ids) && ids.length) {
        const [vals] = await redis([["MGET", ...ids.map(kT)]]);
        tournaments = (vals || [])
          .map((v) => { try { return v ? JSON.parse(v) : null; } catch (e) { return null; } })
          .filter(Boolean);
      }
      return res.status(200).json({ configured: true, rev: toNum(rev), tournaments });
    }

    // -------- Écriture --------
    if (req.method === "POST") {
      const body = readBody(req);
      const op = body.op;

      if (op === "upsert" && body.tournament && body.tournament.id) {
        const t = body.tournament;
        const out = await redis([
          ["SET", kT(t.id), JSON.stringify(t)],
          ["SADD", K_IDS, t.id],
          ["INCR", K_REV],
        ]);
        return res.status(200).json({ ok: true, configured: true, rev: toNum(out[2]) });
      }

      if (op === "delete" && body.id) {
        const out = await redis([
          ["DEL", kT(body.id)],
          ["SREM", K_IDS, body.id],
          ["INCR", K_REV],
        ]);
        return res.status(200).json({ ok: true, configured: true, rev: toNum(out[2]) });
      }

      if (op === "replaceAll" && Array.isArray(body.tournaments)) {
        const [ids] = await redis([["SMEMBERS", K_IDS]]);
        const cmds = [];
        if (Array.isArray(ids) && ids.length) {
          cmds.push(["DEL", ...ids.map(kT)]);
          cmds.push(["DEL", K_IDS]);
        }
        for (const t of body.tournaments) {
          if (!t || !t.id) continue;
          cmds.push(["SET", kT(t.id), JSON.stringify(t)]);
          cmds.push(["SADD", K_IDS, t.id]);
        }
        cmds.push(["INCR", K_REV]);
        const out = await redis(cmds);
        return res.status(200).json({ ok: true, configured: true, rev: toNum(out[out.length - 1]) });
      }

      return res.status(400).json({ error: "Opération invalide." });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Méthode non autorisée." });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
