/* ============================================================
   app.js — Interface : routeur SPA + vues (v3)
   The Travellers — Tournois de backgammon

   - Toute mutation passe par TG.Store (jamais d'écriture directe).
   - Tout texte saisi par un utilisateur est échappé (esc).
   - Les appels à TG.Cloud sont protégés (fonctions optionnelles).
   ============================================================ */
(function () {
  "use strict";

  const Store = TG.Store;
  const $app = document.getElementById("app");
  const DB_KEY = "tg_backgammon_db_v1";
  const LOGO = "icons/icon-192.png?v=6";

  /** Petits états d'interface conservés entre deux rendus. */
  const ui = { q: "", qTid: null, plq: "", corrQ: "", corrAll: false, bulkOpen: false, bulkText: "", addName: "", addTid: null };

  // ============================================================
  //  Cloud : appels protégés (cloud.js peut évoluer / manquer)
  // ============================================================
  function cloudHas(name) {
    const C = window.TG && TG.Cloud;
    return !!(C && typeof C[name] === "function");
  }
  function cloudCall(name) {
    if (!cloudHas(name)) return undefined;
    try { return TG.Cloud[name].apply(TG.Cloud, Array.prototype.slice.call(arguments, 1)); }
    catch (e) { console.warn("Cloud." + name, e); return undefined; }
  }
  function isCloud() { return !!cloudCall("isCloud"); }
  function cloudStatus() { return cloudCall("getStatus") || "local"; }
  function pendingOps() { const n = Number(cloudCall("pendingCount")); return Number.isFinite(n) && n > 0 ? n : 0; }

  // ============================================================
  //  Utilitaires
  // ============================================================
  function el(html) { const t = document.createElement("template"); t.innerHTML = String(html).trim(); return t.content.firstElementChild; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /** Nombre sûr pour l'interpolation HTML (données stockées : jamais de texte brut). */
  function nz(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  function plural(n, one, many) { n = nz(n); return n + " " + (n > 1 ? (many || one + "s") : one); }
  function ordinal(n) { n = nz(n); return n === 1 ? "1er" : n + "e"; }
  function signed(n) { n = nz(n); return n > 0 ? "+" + n : n < 0 ? "−" + Math.abs(n) : "0"; }
  function pname(t, pid) { return Store.playerName(t, pid); }
  const LETTER = /^[\p{L}]/u;
  /** « Alice M. » — premier point de code (jamais de demi-emoji), nombres gardés entiers. */
  function shortName(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return parts[0] || "";
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      if (/^\d/.test(p)) return parts[0] + " " + p;
      if (LETTER.test(p)) return parts[0] + " " + Array.from(p)[0].toUpperCase() + ".";
    }
    return parts[0];
  }
  /** « Jean-Christophe Bertrand » → « J.-C. Bertrand » (garde le nom de famille). */
  function initialsName(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2 || !LETTER.test(parts[0]) || !parts.slice(1).some((p) => LETTER.test(p))) return null;
    const ini = parts[0].split("-").filter(Boolean).map((x) => Array.from(x)[0].toUpperCase() + ".").join("-");
    return ini + " " + parts.slice(1).join(" ");
  }
  /** « Jean-Christophe Bertrand » → « Bertrand » (nom de famille ; nom entier s'il est seul). */
  function lastName(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    return parts.length > 1 ? parts.slice(1).join(" ") : (parts[0] || "");
  }
  // Mesure de texte (canvas) pour adapter les noms à la largeur des cartes de l'arbre.
  let measureCtx = null;
  const measureCache = new Map();
  function textWidth(str, font) {
    const k = font + "|" + str;
    if (measureCache.has(k)) return measureCache.get(k);
    if (!measureCtx) { try { measureCtx = document.createElement("canvas").getContext("2d"); } catch (e) { measureCtx = null; } }
    let w = String(str).length * 9;
    if (measureCtx) { measureCtx.font = font; w = measureCtx.measureText(String(str)).width; }
    if (measureCache.size > 5000) measureCache.clear();
    measureCache.set(k, w);
    return w;
  }
  /** Nom complet s'il tient, sinon prénom(s) en initiales ; l'ellipse CSS reste le dernier recours. */
  function fitName(name, px, font) {
    name = String(name || "");
    if (!px || textWidth(name, font) <= px) return name;
    const ab = initialsName(name);
    return ab || name;
  }
  function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }
  function fmtDate(d, long) {
    if (!d) return "—";
    const dt = new Date(d + "T12:00:00");
    if (isNaN(dt.getTime())) return String(d);
    return dt.toLocaleDateString("fr-FR", long ? { weekday: "long", day: "numeric", month: "long", year: "numeric" } : { day: "numeric", month: "short", year: "numeric" });
  }
  function fmtTime(ts) { return new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); }
  function ago(ts) {
    if (!ts) return "";
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 45) return "à l’instant";
    if (s < 3600) return "il y a " + Math.max(1, Math.round(s / 60)) + " min";
    return "à " + fmtTime(ts);
  }
  function pref(k, d) { try { const v = localStorage.getItem("tg_ui_" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function setPref(k, v) { try { localStorage.setItem("tg_ui_" + k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } }
  function slug(s) { return norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tournoi"; }

  const SHORT_ROUNDS = ["Finale", "Demies", "Quarts", "8es", "16es", "32es", "64es"];
  function shortRound(K, r) { return SHORT_ROUNDS[K - r] || ("Tour " + r); }

  /** Libellé d'étape d'un match : « Phase 1 · match 4 », « Quarts de finale », « Consolante · Demies »… */
  function stageLabel(st, m, long) {
    if (m.stage === "p1") {
      if (m.isFinal) return long ? "Finale (match unique)" : "Finale";
      return long ? "Phase 1 · match " + (m.index + 1) : "Phase 1";
    }
    if (m.stage === "main") return long ? Store.roundName(st.main.totalRounds, m.round) : shortRound(st.main.totalRounds, m.round);
    const K = st.consolante ? st.consolante.totalRounds : m.round;
    return "Consolante · " + (long ? Store.roundName(K, m.round) : shortRound(K, m.round));
  }

  function realMatches(list) { return list.filter((m) => !m.bye); }
  function countDone(list) { return list.filter((m) => m.status === "done").length; }
  function firstOpenRound(rounds) {
    for (let r = 0; r < rounds.length; r++) if (rounds[r].some((m) => m.status !== "done")) return r + 1;
    return 0;
  }

  /** Statut global d'un tournoi (cartes d'accueil, en-tête). */
  function tStatus(t, st) {
    if (!st.drawn) return { cls: "slate", label: "Inscriptions" };
    if (st.main.size <= 1) {
      // 2 joueurs : le match unique est la finale.
      if (st.champion) return { cls: "ok", label: "Terminé · 🏆 " + pname(t, st.champion) };
      return { cls: "gold live", label: "Finale · à jouer" };
    }
    if (!st.phase1.done) return { cls: "gold live", label: "Phase 1 · " + st.phase1.played + "/" + st.phase1.total };
    if (!st.champion) {
      const r = firstOpenRound(st.main.rounds);
      return { cls: "gold live", label: "Tableau final" + (r ? " · " + shortRound(st.main.totalRounds, r) : "") };
    }
    const champ = pname(t, st.champion);
    if (st.consolante && !st.consolante.champion) return { cls: "gold live", label: "🏆 " + champ + " · consolante en cours" };
    return { cls: "ok", label: "Terminé · 🏆 " + champ };
  }

  function pillHtml(cls, label) { return `<span class="pill ${esc(cls)}"><i></i>${esc(label)}</span>`; }

  /** Aperçu du déroulé pour n joueurs. */
  function planInfo(t, n) {
    const pl = Store.plan(n);
    if (!pl.ok) return { ok: false, pl, text: "Il faut au moins 2 joueurs pour lancer le tirage." };
    const consOn = t.settings.consolante !== false;
    let parts;
    if (pl.size === 1) parts = ["Finale directe (1 match)"];
    else {
      parts = [
        "Phase 1 : " + plural(pl.phase1Matches, "match", "matchs") + (pl.exempt ? " + 1 exempt" : ""),
        pl.size === 2 ? "Finale entre les 2 qualifiés" : "Tableau final de " + pl.size + " (" + (pl.repechage ? plural(pl.repechage, "repêché") : "aucun repêché") + ")",
        !consOn ? "Consolante désactivée" : (pl.consolante >= 2 ? "Consolante : " + pl.consolante : "Pas de consolante"),
      ];
    }
    return { ok: true, pl, consOn, text: plural(pl.n, "joueur") + " → " + parts.join(" · ") };
  }

  // ============================================================
  //  Statut d'un joueur → texte clair (« que dois-je faire ? »)
  // ============================================================
  const ROUND_SING = { "Finale": "finale", "Demi-finales": "demi-finale", "Quarts de finale": "quart de finale" };
  function roundSing(K, r) {
    const n = Store.roundName(K, r);
    if (ROUND_SING[n]) return ROUND_SING[n];
    const x = /^(\d+)es de finale$/.exec(n);
    return x ? x[1] + "e de finale" : n.toLowerCase();
  }
  /** « demi-finale », « match n°4 de la phase 1 », « quart de finale de consolante »… */
  function matchSing(st, m) {
    if (m.stage === "p1") return "match n°" + (nz(m.index) + 1) + " de la phase 1";
    if (m.stage === "main") return roundSing(st.main.totalRounds, m.round);
    return roundSing(st.consolante ? st.consolante.totalRounds : m.round, m.round) + " de consolante";
  }

  /** Décrit la provenance d'un adversaire inconnu (HTML, noms échappés). */
  function srcHtml(t, st, src) {
    if (!src) return "votre adversaire";
    if (src.type === "rep") return "le repêché n°" + nz(src.k);
    if (src.type === "exempt") return `<b>${esc(pname(t, src.pid))}</b>`;
    if (src.type !== "p1" && src.type !== "winner") return "votre adversaire";
    const m = st.byId[src.matchId];
    if (!m) return "votre adversaire";
    const known = [m.p1, m.p2].filter((p) => p && p !== "BYE");
    if (known.length === 2) return `le vainqueur de <b>${esc(pname(t, m.p1))}</b> – <b>${esc(pname(t, m.p2))}</b>`;
    if (known.length === 1) return `le vainqueur du match de <b>${esc(pname(t, known[0]))}</b> (${esc(matchSing(st, m))})`;
    return "le vainqueur de l’autre " + esc(matchSing(st, m));
  }

  /** Matchs réellement en jeu (prêts) qui décideront d'un siège : on remonte la chaîne. */
  function feedersInPlay(st, m, acc, depth) {
    acc = acc || { ready: [], rep: false };
    depth = depth || 0;
    if (!m || depth > 10) return acc;
    if (m.status === "ready") { acc.ready.push(m); return acc; }
    if (m.status === "done") return acc;
    [1, 2].forEach((k) => {
      if (m["p" + k]) return;
      const s = m["src" + k];
      if (!s) return;
      if (s.type === "rep") acc.rep = true;
      else if (s.type === "p1" || s.type === "winner") feedersInPlay(st, st.byId[s.matchId], acc, depth + 1);
    });
    return acc;
  }
  function waitDetailHtml(t, st, src) {
    if (!src || (src.type !== "p1" && src.type !== "winner")) return "";
    const m = st.byId[src.matchId];
    if (!m) return "";
    const f = feedersInPlay(st, m);
    if (f.ready.length === 1 && f.ready[0] === m) return "ce match est à jouer";
    const pair = (x) => `<b>${esc(pname(t, x.p1))}</b> – <b>${esc(pname(t, x.p2))}</b>`;
    const parts = [];
    if (f.ready.length) parts.push("en jeu : " + f.ready.slice(0, 4).map(pair).join(", ") + (f.ready.length > 4 ? ` … (+${f.ready.length - 4})` : ""));
    if (f.rep) parts.push("après la fin de la phase 1 (repêchés)");
    return parts.join(" · ");
  }

  function statusInfo(t, st, pid, s, ctx) {
    s = s || Store.playerStatus(t, pid);
    ctx = ctx || {};
    const N = (id) => `<b>${esc(pname(t, id))}</b>`;
    const picked = st.repechage.picks.indexOf(pid) >= 0;
    const consFuture = t.settings.consolante !== false && st.plan.ok && st.plan.consolante >= 2;
    switch (s.kind) {
      case "notDrawn":
        return { cls: "neutral", icon: "•", title: "Inscrit", sub: "Le tirage au sort n’est pas encore fait." };
      case "play": {
        const m = s.match;
        const pre = m.stage === "cons" ? "Consolante — " : (picked && ctx.justPicked ? "Repêché ! " : "");
        return {
          cls: "play", icon: "▶", match: m,
          title: `${pre}Jouez maintenant contre ${N(s.opponent)}`,
          sub: `Votre adversaire est prêt · ${esc(stageLabel(st, m, true))} · en ${plural(m.points, "point")}`,
        };
      }
      case "wait": {
        const m = s.match, w = s.waitFor || {};
        const pre = m.stage === "cons" ? "Consolante — " : (picked && ctx.justPicked ? "Repêché ! " : "");
        const where = `${esc(stageLabel(st, m, true))} · en ${plural(m.points, "point")}`;
        if (w.type === "rep") {
          return { cls: "wait", icon: "⏳", title: `${pre}Attendez la fin de la phase 1 (repêchés)`, sub: `Vous affronterez le repêché n°${nz(w.k)} (meilleur perdant) · ${where}` };
        }
        const detail = waitDetailHtml(t, st, w);
        return { cls: "wait", icon: "⏳", title: `${pre}Attendez ${srcHtml(t, st, w)}`, sub: `Prochain match : ${where}${detail ? " · " + detail : ""}` };
      }
      case "repechable": {
        if (!s.needed) {
          return {
            cls: "out", icon: "↘",
            title: consFuture ? "Direction la consolante" : "Éliminé",
            sub: consFuture ? "Pas de repêchage dans ce tournoi : vous jouerez la consolante à la fin de la phase 1." : "Pas de repêchage dans ce tournoi.",
          };
        }
        return {
          cls: s.inZone ? "rep in" : "rep", icon: s.inZone ? "★" : "☆",
          title: `${ordinal(s.rank)} des perdants — ${plural(s.needed, "place")} de repêchage`,
          sub: `${s.inZone ? "Dans la zone pour l’instant" : "Hors zone pour l’instant"} (${plural(s.pf, "pt marqué", "pts marqués")}) · réponse en fin de phase 1${!s.inZone && consFuture ? " — sinon consolante" : ""}`,
        };
      }
      case "champion":
        return { cls: "champ", icon: "🏆", title: "Champion !", sub: "Vainqueur du tableau final — félicitations !" };
      case "consoleChampion":
        return { cls: "champ", icon: "🏆", title: "Vainqueur de la consolante !", sub: "Félicitations !" };
      default: {
        const lost = st.all.filter((m) => m.status === "done" && !m.bye && m.loser === pid).pop();
        const title = lost && lost.stage === "cons" ? "Éliminé de la consolante" : "Éliminé";
        const sub = lost ? `Battu par ${N(lost.winner)} · ${esc(stageLabel(st, lost, true))} · merci d’avoir joué !` : "Merci d’avoir joué !";
        return { cls: "out", icon: "✕", title, sub };
      }
    }
  }

  function statusCardHtml(info) {
    return `<div class="status-card ${info.cls}"><div class="sc-ico">${info.icon}</div><div class="sc-txt"><div class="sc-title">${info.title}</div>${info.sub ? `<div class="sc-sub">${info.sub}</div>` : ""}</div></div>`;
  }

  /** Pastille de statut courte (listes). */
  function chipFor(st, pid, s) {
    const picked = st.repechage.picks.indexOf(pid) >= 0;
    switch (s.kind) {
      case "play": return ["play", s.match.stage === "cons" ? "À jouer · consolante" : "À jouer"];
      case "wait":
        if (s.match.stage === "cons") return ["cons", "Consolante · en attente"];
        return ["qual", (picked ? "Repêché" : "Qualifié") + " · en attente"];
      case "repechable": return s.needed ? [s.inZone ? "rep in" : "rep", "Repêchable n°" + nz(s.rank)] : ["out", "Perdu · phase 1"];
      case "champion": return ["champ", "🏆 Champion"];
      case "consoleChampion": return ["champ", "🏆 Consolante"];
      case "notDrawn": return ["neutral", "Inscrit"];
      default: return ["out", "Éliminé"];
    }
  }

  // ============================================================
  //  Toast
  // ============================================================
  /** Message éphémère. Les toasts ne bloquent jamais les taps (seul leur bouton est cliquable). */
  function toast(msg, kind, action, opts) {
    opts = opts || {};
    let wrap = $(".toast-wrap");
    if (!wrap) { wrap = el('<div class="toast-wrap" role="status" aria-live="polite"></div>'); document.body.appendChild(wrap); }
    const node = el(`<div class="toast ${esc(kind || "")}"><span>${esc(msg)}</span></div>`);
    let gone = false;
    const dismiss = () => { if (gone) return; gone = true; node.classList.add("out"); setTimeout(() => node.remove(), 300); };
    if (action) {
      const b = el(`<button type="button">${esc(action.label)}</button>`);
      b.onclick = () => { try { action.fn(); } finally { dismiss(); } };
      node.appendChild(b);
    }
    wrap.appendChild(node);
    while (wrap.children.length > 3) wrap.firstElementChild.remove();
    setTimeout(dismiss, opts.ms || (action ? 6000 : 2800));
  }

  // ============================================================
  //  Garde anti double-tap
  //  Après l'ouverture / la fermeture d'une modale (ou une action de liste
  //  qui re-dessine sous le doigt), un 2e tap au même endroit est ignoré :
  //  il ne doit jamais « traverser » vers la page ou la modale suivante.
  // ============================================================
  const GUARD_ANY = 0, GUARD_NEAR = 500, NEAR_PX = 56;   // un double-tap retombe au même endroit
  let lastTap = { x: -1e4, y: -1e4, t: 0 };
  let tapGuard = { x: -1e4, y: -1e4, t: 0, near: GUARD_NEAR };
  /** Une transition vient d'avoir lieu (modale ouverte/fermée, liste redessinée). */
  function markTransition(nearMs) {
    const now = Date.now();
    if (now - lastTap.t > 80) return;             // transition non causée par ce tap (clavier, code) : pas de garde
    tapGuard = { x: lastTap.x, y: lastTap.y, t: now, near: nearMs || GUARD_NEAR };
  }
  document.addEventListener("click", (e) => {
    if (!e.isTrusted || e.detail === 0) return;          // clics de script / clavier : pas de garde
    const now = Date.now(), dt = now - tapGuard.t;
    const near = Math.abs(e.clientX - tapGuard.x) < NEAR_PX && Math.abs(e.clientY - tapGuard.y) < NEAR_PX;
    if (dt < GUARD_ANY || (near && dt < tapGuard.near)) {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      return;
    }
    lastTap = { x: e.clientX, y: e.clientY, t: now };
  }, true);

  // ============================================================
  //  Historique : chaque modale a sa propre entrée → « Retour » la ferme
  // ============================================================
  let histPending = 0, histQueue = [], histTimer = null;
  function flushHist() { const q = histQueue; histQueue = []; q.forEach((f) => { try { f(); } catch (e) { console.error(e); } }); }
  /** Exécute fn quand l'historique est stable (aucun retour en cours). */
  function whenHistIdle(fn) { if (histPending > 0) histQueue.push(fn); else fn(); }
  function histBack() {
    histPending++;
    clearTimeout(histTimer);
    histTimer = setTimeout(() => { if (histPending) { histPending = 0; flushHist(); } }, 700);
    try { history.back(); } catch (e) { histPending = 0; flushHist(); }
  }
  window.addEventListener("popstate", () => {
    if (histPending > 0) {
      histPending--;
      if (!histPending) { clearTimeout(histTimer); flushHist(); }
      return;
    }
    // Retour système (Android, navigateur) : on ferme la modale du dessus, la page ne bouge pas.
    const top = modalStack[modalStack.length - 1];
    if (top && top.histPushed) top.close("back", true);
  });

  // ============================================================
  //  Modales (feuille du bas sur mobile)
  // ============================================================
  const modalStack = [];
  let modalSeq = 0;
  /** Page derrière les modales : inerte (ni focus ni clic) tant qu'une modale est ouverte. */
  function syncInert() {
    const open = modalStack.length > 0;
    ["app", "topbar", "footer"].forEach((id) => { const n = document.getElementById(id); if (n) n.toggleAttribute("inert", open); });
    modalStack.forEach((m, i) => m.overlay.toggleAttribute("inert", i < modalStack.length - 1));
  }
  function focusables(root) {
    return $$('button:not([disabled]),[href],input:not([disabled]):not([type=hidden]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])', root)
      .filter((n) => n.tabIndex >= 0 && (n.offsetParent !== null || n === document.activeElement));
  }
  function modal(o) {
    const root = document.getElementById("modal-root") || document.body;
    const overlay = el('<div class="modal-overlay"></div>');
    const box = el(`<div class="modal ${esc(o.cls || "")}" role="dialog" aria-modal="true" tabindex="-1"></div>`);
    let closed = false;
    const returnFocus = document.activeElement;
    const id = ++modalSeq;
    const api = {
      id, overlay, box, body: null, foot: null, onEnter: o.onEnter || null, dismissible: o.dismissible !== false,
      openedAt: Date.now(), histPushed: false,
      get closed() { return closed; },
      close(reason, fromPop) {
        if (closed) return;
        closed = true;
        overlay.classList.add("closing");
        const i = modalStack.indexOf(api);
        if (i >= 0) modalStack.splice(i, 1);
        markTransition();
        syncInert();
        // L'overlay qui se ferme continue d'intercepter les clics (pas de « traversée »).
        setTimeout(() => overlay.remove(), 180);
        if (api.histPushed && !fromPop && reason !== "nav") histBack();
        if (o.onClose) { try { o.onClose(reason); } catch (e) { console.error(e); } }
        const top = modalStack[modalStack.length - 1];
        if (top) { try { top.box.focus({ preventScroll: true }); } catch (e) { /* */ } }
        else if (returnFocus && returnFocus.isConnected && returnFocus !== document.body && !returnFocus.closest(".modal-overlay")) {
          try { returnFocus.focus({ preventScroll: true }); } catch (e) { /* */ }
        }
      },
    };
    if (o.title != null || o.titleHtml) {
      const head = el(`<div class="modal-head"><div class="modal-title">${o.titleHtml || `<h3>${esc(o.title)}</h3>`}</div><button class="close-x" type="button" aria-label="Fermer">×</button></div>`);
      head.querySelector(".close-x").onclick = () => api.close("x");
      box.appendChild(head);
    }
    api.body = el('<div class="modal-body"></div>');
    (o.body || []).forEach((n) => { if (n) api.body.appendChild(typeof n === "string" ? el(n) : n); });
    box.appendChild(api.body);
    api.foot = el('<div class="modal-foot"></div>');
    (o.actions || []).forEach((a) => {
      const b = el(`<button type="button" class="btn ${esc(a.cls || "")}">${esc(a.label)}</button>`);
      b.onclick = () => { if (closed || b.disabled) return; a.onClick(api.close, b); };
      api.foot.appendChild(b);
    });
    box.appendChild(api.foot);
    overlay.appendChild(box);
    overlay.addEventListener("click", (e) => { if (e.target === overlay && api.dismissible && !closed) api.close("backdrop"); });
    root.appendChild(overlay);
    modalStack.push(api);
    markTransition(o.guardMs);
    syncInert();
    // Entrée d'historique (différée si un retour est en cours).
    whenHistIdle(() => {
      if (closed) return;
      try { history.pushState({ tgModal: id }, ""); api.histPushed = true; } catch (e) { /* */ }
    });
    // Focus dans la modale : premier champ sur ordinateur, sinon la boîte elle-même.
    const hover = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    let target = null;
    if (o.focus) target = typeof o.focus === "function" ? o.focus(api) : o.focus;
    else if (o.autofocus !== false && hover) target = api.body.querySelector("input:not([type=checkbox]),textarea,select");
    try { (target && hover ? target : box).focus({ preventScroll: true }); } catch (e) { /* */ }
    if (target && hover && target.select) { try { target.select(); } catch (e) { /* */ } }
    return api;
  }
  function anyModalOpen() { return modalStack.length > 0; }
  function closeAllModals(reason) { modalStack.slice().reverse().forEach((m) => m.close(reason || "nav")); }

  let lastEnterAt = 0;
  document.addEventListener("keydown", (e) => {
    let prevEnter = 0;
    if (e.key === "Enter") { prevEnter = lastEnterAt; lastEnterAt = Date.now(); }
    const top = modalStack[modalStack.length - 1];
    if (!top) return;
    if (e.key === "Escape" && top.dismissible) { e.preventDefault(); top.close("esc"); return; }
    if (e.key === "Tab") {
      // Piège du focus dans la modale du dessus.
      const f = focusables(top.box);
      if (!f.length) { e.preventDefault(); top.box.focus(); return; }
      const first = f[0], last = f[f.length - 1], a = document.activeElement;
      if (!top.box.contains(a)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && (a === first || a === top.box)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
      return;
    }
    if (e.key === "Enter" && top.onEnter && !(e.target && e.target.tagName === "TEXTAREA")) {
      // Les boutons d'action (pied, ×) gardent leur comportement natif (Entrée = clic).
      if (e.target && e.target.closest && e.target.closest(".modal-foot button, .close-x") && top.box.contains(e.target)) return;
      e.preventDefault();
      if (e.repeat || Date.now() - prevEnter < 300) return;   // Entrée « en double » (ou maintenue)
      top.onEnter();
    }
  });

  /** Confirmation (promesse → true/false). Chaque bouton n'agit qu'une fois. */
  function ask(o) {
    return new Promise((resolve) => {
      let yes = false;
      const m = modal({
        title: o.title, cls: "ask" + (o.cls ? " " + o.cls : ""),
        body: [el(`<div class="ask-text">${o.html || esc(o.text || "")}</div>`)],
        actions: [
          { label: o.cancel || "Annuler", cls: "subtle", onClick: (c) => c("cancel") },
          { label: o.ok || "Confirmer", cls: o.danger ? "danger-solid" : "", onClick: (c) => { yes = true; c("ok"); } },
        ],
        onClose: () => resolve(yes),
      });
      m.onEnter = () => { yes = true; m.close("ok"); };
    });
  }

  function field(label, inputHtml, hint) {
    return `<label class="field"><span class="field-label">${esc(label)}</span>${inputHtml}${hint ? `<small class="field-hint">${esc(hint)}</small>` : ""}</label>`;
  }

  /** Champ numérique avec stepper −/+. */
  function numField(label, value, min, max, hint, onChange) {
    value = nz(value);
    const node = el(`<div class="numfield">
      <div class="nf-label">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ""}</div>
      <div class="stepper sm">
        <button type="button" class="minus" aria-label="Moins">−</button>
        <input type="number" inputmode="numeric" min="${nz(min)}" max="${nz(max)}" value="${value}" aria-label="${esc(label)}" />
        <button type="button" class="plus" aria-label="Plus">+</button>
      </div></div>`);
    const input = node.querySelector("input");
    const clamp = (v) => Math.max(min, Math.min(max, v));
    const get = () => { const v = parseInt(input.value, 10); return Number.isFinite(v) ? clamp(v) : value; };
    const changed = () => { if (onChange) onChange(); };
    node.querySelector(".minus").onclick = () => { input.value = clamp(get() - 1); changed(); };
    node.querySelector(".plus").onclick = () => { input.value = clamp(get() + 1); changed(); };
    input.addEventListener("input", changed);
    input.addEventListener("focus", () => input.select());
    return { node, get };
  }

  // ============================================================
  //  Routeur
  // ============================================================
  const routes = [];
  let viewCleanup = null;     // nettoyage de la vue courante (timers, écouteurs)
  let live = null;            // rafraîchissement « en direct » (vue arbre)
  let liveTimer = null;
  let pendingRefresh = false; // un changement distant attend la fin d'une saisie
  let navCount = 0;
  let currentPath = null;
  /** Formulaire Réglages en cours d'édition : { tid, node, dirty, K, remoteSeen, ... } (jamais effacé par un changement distant). */
  let settingsForm = null;

  function route(pattern, handler) {
    const keys = [];
    const rx = new RegExp("^" + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return "([^/]+)"; }) + "$");
    routes.push({ rx, keys, handler });
  }
  function navigate(hash) {
    // Si une modale vient de se fermer, on attend que son entrée d'historique soit retirée.
    whenHistIdle(() => { if (location.hash === hash) render(); else location.hash = hash; });
  }
  function parseHash() { const h = location.hash.replace(/^#/, ""); return h || "/"; }
  function isTreePath(p) { return /^\/t\/[^/]+\/bracket$/.test(p); }
  /** decodeURIComponent qui ne lève jamais (lien tronqué, « % » isolé…). */
  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return null; } }
  function tabOf(path) { const m = /^\/t\/[^/]+\/([a-z]+)/.exec(path || ""); return m ? m[1] : ""; }
  function tidOf(path) { const m = /^\/t\/([^/#]+)/.exec(path || ""); return m ? safeDecode(m[1]) : null; }

  function render(opts) {
    opts = opts || {};
    if (viewCleanup) { try { viewCleanup(); } catch (e) { console.error(e); } viewCleanup = null; }
    live = null;
    pendingRefresh = false;
    const path = parseHash();
    const same = path === currentPath;
    const prevPath = currentPath;
    currentPath = path;
    if (!same) onPathChange(prevPath, path);
    const y = window.scrollY;
    document.body.classList.toggle("fullbleed", isTreePath(path));
    clear($app);
    let matched = false;
    for (const r of routes) {
      const m = path.match(r.rx);
      if (!m) continue;
      const params = {};
      let bad = false;
      r.keys.forEach((k, i) => { const v = safeDecode(m[i + 1]); if (v == null) bad = true; params[k] = v; });
      if (bad) break;
      try { r.handler(params); } catch (e) {
        console.error(e);
        document.body.classList.remove("fullbleed");
        clear($app);
        $app.appendChild(el(`<div class="card empty"><div class="ico">⚠︎</div><h2>Erreur d’affichage</h2><p>${esc(e && e.message)}</p><a class="btn" href="#/">Accueil</a></div>`));
      }
      matched = true;
      break;
    }
    if (!matched) {
      document.body.classList.remove("fullbleed");
      $app.appendChild(el('<div class="empty"><div class="ico">🧭</div><h2>Page introuvable</h2><p>Le lien est peut-être incomplet.</p><a class="btn" href="#/">Retour à l’accueil</a></div>'));
    }
    if (opts.keepScroll && same) window.scrollTo(0, y); else window.scrollTo(0, 0);
    renderNav();
  }

  /** Changement de page : on oublie les filtres propres à l'ancienne page. */
  function onPathChange(prev, next) {
    const prevTab = tabOf(prev), nextTab = tabOf(next), prevTid = tidOf(prev), nextTid = tidOf(next);
    if (nextTab !== "scores" || prevTid !== nextTid) { ui.q = ""; }
    if (prevTid !== nextTid) { ui.plq = ""; ui.corrQ = ""; ui.corrAll = false; }
    if (prevTab === "settings" && nextTab !== "settings" && settingsForm && settingsForm.dirty && settingsForm.tid === prevTid && nextTid === prevTid) {
      toast("Réglages non enregistrés — ils vous attendent dans l’onglet Réglages.", "warn", null, { ms: 4000 });
    }
    if (settingsForm && settingsForm.tid !== nextTid) settingsForm = null;
  }

  function renderNav() {
    const tid = tidOf(parseHash());
    let title = "The Travellers — Backgammon";
    if (tid) { const t = Store.getTournament(tid); if (t) title = t.name + " — The Travellers"; }
    document.title = title;
  }

  /** L'utilisateur est-il en train de saisir / une modale est-elle ouverte ? */
  function isBusy() {
    const a = document.activeElement;
    const typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== "checkbox" && a.type !== "button";
    return !!typing || anyModalOpen();
  }
  function scheduleLive() {
    if (!live) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { if (live) live(); }, 40);
  }
  /** Données modifiées ailleurs (cloud, autre onglet) : rafraîchir sans gêner. */
  function externalChange() {
    if (live) { scheduleLive(); return; }
    if (settingsForm && settingsForm.dirty && tabOf(currentPath) === "settings") settingsForm.remoteSeen = true;
    if (isBusy()) { pendingRefresh = true; return; }
    render({ keepScroll: true });
  }
  /** Re-rendu local après une action (garde la position de défilement). */
  function refresh() { render({ keepScroll: true }); }

  // Premier chargement des données terminé (cloud synchronisé, ou mode local confirmé).
  let firstSyncDone = false;
  function notFound() {
    document.body.classList.remove("fullbleed");
    // Pendant le tout premier téléchargement (connexion lente), le tournoi n'est pas
    // « introuvable » : il n'est pas encore arrivé. La page se redessine à son arrivée.
    if (!firstSyncDone && cloudStatus() !== "local") {
      $app.appendChild(el('<div class="empty loading"><div class="ico">⏳</div><h2>Chargement du tournoi…</h2><p>Récupération des données partagées.</p></div>'));
      return;
    }
    $app.appendChild(el('<div class="empty"><div class="ico">🔍</div><h2>Tournoi introuvable</h2><p>Il a peut-être été supprimé.</p><a class="btn" href="#/">Retour à l’accueil</a></div>'));
  }

  // ============================================================
  //  En-tête de tournoi + onglets
  // ============================================================
  function shell(t, tab) {
    const st = Store.state(t);
    const s = tStatus(t, st);
    $app.appendChild(el(`<header class="t-head">
      <a class="back-link" href="#/">‹ Tous les tournois</a>
      <div class="t-head-row">
        <div class="t-head-main">
          <h1>${esc(t.name)}</h1>
          <div class="t-head-meta">${esc(fmtDate(t.date, true))} · <span data-pcount>${plural(t.players.length, "joueur")}</span></div>
        </div>
        ${pillHtml(s.cls, s.label)}
      </div>
    </header>`));
    const tabs = el('<nav class="subtabs" aria-label="Sections du tournoi"></nav>');
    [["players", "Joueurs"], ["bracket", "Tableau"], ["scores", "Scores"], ["settings", "Réglages"]].forEach(([k, label]) => {
      const badge = k === "scores" && st.drawn && st.progress.ready ? `<span class="tab-badge">${nz(st.progress.ready)}</span>` : "";
      tabs.appendChild(el(`<a href="#/t/${encodeURIComponent(t.id)}/${k}" class="${tab === k ? "active" : ""}" data-tab="${k}">${esc(label)}${badge}</a>`));
    });
    $app.appendChild(tabs);
    return st;
  }

  function sectionTitle(title, extra) {
    return `<div class="section-title"><h2>${title}</h2>${extra || ""}<div class="line"></div></div>`;
  }

  // ============================================================
  //  VUE : Accueil
  // ============================================================
  route("/", function () {
    const list = Store.listTournaments();
    const head = el(`<div class="page-head">
      <div>
        <div class="eyebrow">The Travellers · Paris</div>
        <h1>Tournois de backgammon</h1>
        <p>${list.length ? "Choisissez un tournoi ou créez-en un nouveau." : "Créez votre premier tournoi pour commencer."}</p>
      </div></div>`);
    const add = el('<button class="btn hide-mobile" type="button">＋ Nouveau tournoi</button>');
    add.onclick = openCreateTournament;
    head.appendChild(add);
    $app.appendChild(head);

    if (!list.length) {
      const empty = el(`<div class="card empty hero-empty">
        <img src="${LOGO}" alt="" class="crest" />
        <h2>Aucun tournoi</h2>
        <p>Un tournoi, une liste de joueurs, un tirage au sort : c’est parti.</p>
        <button class="btn" type="button">＋ Créer un tournoi</button></div>`);
      empty.querySelector("button").onclick = openCreateTournament;
      $app.appendChild(empty);
    } else {
      const grid = el('<div class="t-grid"></div>');
      list.forEach((t) => grid.appendChild(tournamentCard(t)));
      $app.appendChild(grid);
    }
    const fab = el('<button class="fab" type="button" title="Nouveau tournoi" aria-label="Nouveau tournoi">＋</button>');
    fab.onclick = openCreateTournament;
    $app.appendChild(fab);
  });

  function tournamentCard(t) {
    const st = Store.state(t);
    const s = tStatus(t, st);
    let foot;
    if (st.drawn) {
      const pct = st.progress.total ? Math.round((st.progress.played / st.progress.total) * 100) : 0;
      const finished = !!st.champion && (!st.consolante || !!st.consolante.champion);
      foot = `<div class="mini-prog${finished ? " done" : ""}"><div class="bar"><i style="width:${nz(pct)}%"></i></div><span>${nz(st.progress.played)}/${nz(st.progress.total)} matchs${st.progress.ready ? ` · <b>${nz(st.progress.ready)} à jouer</b>` : ""}</span></div>`;
    } else {
      const pi = planInfo(t, t.players.length);
      foot = `<div class="mini-plan">${esc(pi.ok ? pi.text.split("→")[1].trim() : "En attente des inscriptions")}</div>`;
    }
    return el(`<a class="t-card" href="#/t/${encodeURIComponent(t.id)}/${st.drawn ? "scores" : "players"}">
      <div class="t-card-top">${pillHtml(s.cls, s.label)}</div>
      <h3>${esc(t.name)}</h3>
      <div class="meta">${esc(fmtDate(t.date))} · ${plural(t.players.length, "joueur")}</div>
      ${foot}
    </a>`);
  }

  function openCreateTournament() {
    const body = el(`<div class="form-stack">
      ${field("Nom du tournoi", '<input type="text" name="name" placeholder="Ex. Open d’automne" maxlength="80" />')}
      ${field("Date", `<input type="date" name="date" value="${new Date().toISOString().slice(0, 10)}" />`)}
    </div>`);
    const create = (close) => {
      const name = body.querySelector("[name=name]").value.trim() || "Nouveau tournoi";
      const t = Store.createTournament(name, body.querySelector("[name=date]").value);
      close();
      navigate("#/t/" + encodeURIComponent(t.id) + "/players");
      toast("Tournoi créé — ajoutez les joueurs.");
    };
    const m = modal({
      title: "Nouveau tournoi", body: [body],
      actions: [{ label: "Annuler", cls: "subtle", onClick: (c) => c() }, { label: "Créer le tournoi", onClick: create }],
    });
    m.onEnter = () => create(m.close);
  }

  route("/t/:id", function (p) {
    const t = Store.getTournament(p.id);
    if (!t) return notFound();
    location.replace("#/t/" + encodeURIComponent(t.id) + (t.draw ? "/scores" : "/players"));
  });

  // ============================================================
  //  VUE : Joueurs
  // ============================================================
  route("/t/:id/players", function (p) {
    const t = Store.getTournament(p.id);
    if (!t) return notFound();
    shell(t, "players");
    if (!t.draw) playersBefore(t.id); else playersAfter(t.id);
  });

  /** Tronque à max unités UTF-16 sans jamais couper un emoji / caractère composé en deux. */
  function cutText(s, max) {
    s = String(s || "");
    if (s.length <= max) return s;
    const a = Array.from(s);
    while (a.length && a.join("").length > max) a.pop();
    return a.join("");
  }
  function cleanNames(text) {
    return String(text || "").split(/\r?\n/).map((n) => cutText(n.replace(/^\s*\d+[.)-]\s*/, "").replace(/\s+/g, " ").trim(), 80).trim()).filter(Boolean);
  }

  function playersBefore(tid) {
    if (ui.addTid !== tid) { ui.addTid = tid; ui.addName = ""; ui.bulkText = ""; ui.bulkOpen = false; }
    const entry = el(`<section class="card entry">
      ${sectionTitle("Inscriptions")}
      <form class="add-row" autocomplete="off">
        <input type="text" name="pname" placeholder="Nom du joueur, puis Entrée" enterkeyhint="enter" maxlength="80" aria-label="Nom du joueur" />
        <button class="btn" type="submit">Ajouter</button>
      </form>
      <details class="bulk"${ui.bulkOpen ? " open" : ""}>
        <summary><span>Coller une liste</span><small>un nom par ligne</small></summary>
        <textarea rows="8" placeholder="Alice Martin&#10;Bob Durand&#10;Claire Petit&#10;…"></textarea>
        <div class="bulk-foot"><span class="bulk-count">Aucun nom détecté</span><button class="btn" type="button" disabled>Ajouter la liste</button></div>
      </details>
    </section>`);
    const dyn = el('<div class="pl-dyn"></div>');
    $app.appendChild(entry);
    $app.appendChild(dyn);

    const form = entry.querySelector("form");
    const input = form.querySelector("input");
    // Texte en cours conservé si la page est redessinée (changement venu d'un autre appareil).
    input.value = ui.addName || "";
    input.addEventListener("input", () => { ui.addName = input.value; });
    form.onsubmit = (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      const t = Store.getTournament(tid);
      if (!t) return;
      const dup = t.players.some((x) => norm(x.name) === norm(name));
      const r = Store.addPlayer(tid, name);
      if (r.error) { toast(r.error, "err"); return; }
      input.value = "";
      ui.addName = "";
      input.focus();
      if (dup) toast("Attention : « " + name + " » est déjà inscrit (doublon).", "warn");
      drawDyn();
    };

    const det = entry.querySelector("details");
    const ta = entry.querySelector("textarea");
    const cnt = entry.querySelector(".bulk-count");
    const bulkBtn = entry.querySelector(".bulk-foot .btn");
    det.addEventListener("toggle", () => { ui.bulkOpen = det.open; });
    ta.value = ui.bulkText || "";
    const countNames = () => {
      const n = cleanNames(ta.value).length;
      cnt.textContent = n ? plural(n, "nom détecté", "noms détectés") : "Aucun nom détecté";
      bulkBtn.disabled = !n;
      bulkBtn.textContent = n ? "Ajouter " + plural(n, "joueur") : "Ajouter la liste";
    };
    ta.addEventListener("input", () => { ui.bulkText = ta.value; countNames(); });
    countNames();
    bulkBtn.onclick = () => {
      const t = Store.getTournament(tid);
      if (!t) return;
      const names = cleanNames(ta.value);
      const existing = new Set(t.players.map((x) => norm(x.name)));
      const dups = names.filter((n) => existing.has(norm(n))).length;
      const r = Store.addPlayers(tid, ta.value);
      if (r.error) { toast(r.error, "err"); return; }
      ta.value = "";
      ui.bulkText = "";
      countNames();
      det.open = false;
      ui.bulkOpen = false;
      toast(plural(r.added, "joueur ajouté", "joueurs ajoutés") + (dups ? " · " + plural(dups, "doublon") + " à vérifier" : ""), dups ? "warn" : "");
      drawDyn();
    };

    function drawDyn() {
      const t = Store.getTournament(tid);
      clear(dyn);
      if (!t) return;
      const pc = $("[data-pcount]");
      if (pc) pc.textContent = plural(t.players.length, "joueur");
      dyn.appendChild(planCard(t));
      dyn.appendChild(playerListCard(t, drawDyn));
    }
    drawDyn();
  }

  function planCard(t) {
    const n = t.players.length;
    const pi = planInfo(t, n);
    const card = el(`<section class="card plan-card ${pi.ok ? "" : "is-empty"}">
      ${sectionTitle("Déroulé")}
      <p class="plan-text" data-plan>${esc(pi.text)}</p>
      ${pi.ok && pi.pl.size > 1 ? `<div class="plan-tiles">
        <div class="tile"><b>${nz(pi.pl.phase1Matches)}</b><span>match${pi.pl.phase1Matches > 1 ? "s" : ""} de phase 1${pi.pl.exempt ? " + 1 exempt" : ""}</span></div>
        <div class="tile"><b>${nz(pi.pl.size)}</b><span>au tableau final</span></div>
        <div class="tile"><b>${nz(pi.pl.repechage)}</b><span>repêché${pi.pl.repechage > 1 ? "s" : ""}</span></div>
        <div class="tile"><b>${pi.consOn && pi.pl.consolante >= 2 ? nz(pi.pl.consolante) : "—"}</b><span>en consolante</span></div>
      </div>` : ""}
      <button class="btn big block draw-btn" type="button" ${pi.ok ? "" : "disabled"}>🎲 Tirage au sort</button>
    </section>`);
    card.querySelector(".draw-btn").onclick = () => openDraw(t.id);
    return card;
  }

  function openDraw(tid) {
    const t = Store.getTournament(tid);
    if (!t) return;
    const pi = planInfo(t, t.players.length);
    if (!pi.ok) { toast(pi.text, "err"); return; }
    ask({
      title: "Tirage au sort",
      html: `<p class="plan-text">${esc(pi.text)}</p><p class="muted">Les paires de la phase 1 et la place de chacun dans le tableau sont tirées au hasard. Après le tirage, la liste des joueurs est figée (on peut annuler le tirage dans Réglages).</p>`,
      ok: "Lancer le tirage",
    }).then((ok) => {
      if (!ok) return;
      const r = Store.drawTournament(tid);
      if (r.error) { toast(r.error, "err"); return; }
      render();
      const t2 = Store.getTournament(tid);
      const st = Store.state(t2);
      modal({
        title: "Tirage effectué ✓", cls: "done-modal",
        body: [el(`<div class="draw-done"><img src="${LOGO}" alt="" class="crest" /><p><b>${plural(st.phase1.total, "match", "matchs")}</b> ${st.phase1.total > 1 ? "sont prêts" : "est prêt"} à être joué${st.phase1.total > 1 ? "s" : ""}${st.exempt ? ` · <b>${esc(pname(t2, st.exempt))}</b> est exempt (qualifié d’office)` : ""}.</p></div>`)],
        actions: [
          { label: "Voir l’arbre", cls: "subtle", onClick: (c) => { c(); navigate("#/t/" + encodeURIComponent(tid) + "/bracket"); } },
          { label: "Saisir les scores", onClick: (c) => { c(); navigate("#/t/" + encodeURIComponent(tid) + "/scores"); } },
        ],
      });
    });
  }

  function playerListCard(t, redraw) {
    const n = t.players.length;
    const counts = {};
    t.players.forEach((p) => { const k = norm(p.name); counts[k] = (counts[k] || 0) + 1; });
    const card = el(`<section class="card">
      ${sectionTitle("Joueurs inscrits", `<span class="count-badge">${nz(n)}</span>`)}
      ${n ? '<ol class="plist"></ol><div class="list-foot"><span class="muted small">Touchez un nom pour le modifier.</span><button type="button" class="btn ghost sm clear-all">Tout retirer</button></div>' : '<div class="empty slim"><p>Aucun joueur pour l’instant. Tapez un nom ci-dessus ou collez une liste.</p></div>'}
    </section>`);
    const ol = card.querySelector(".plist");
    if (ol) {
      t.players.forEach((p, i) => {
        const li = el(`<li>
          <button type="button" class="pl-name"><span class="pl-num">${nz(i + 1)}</span><span class="pl-txt">${esc(p.name)}</span>${counts[norm(p.name)] > 1 ? '<span class="pill warn sm"><i></i>doublon</span>' : ""}</button>
          <button type="button" class="pl-x" aria-label="Retirer ${esc(p.name)}" title="Retirer">✕</button>
        </li>`);
        li.querySelector(".pl-name").onclick = () => openPlayerEdit(t.id, p.id, redraw);
        li.querySelector(".pl-x").onclick = () => {
          // Garde AVANT le travail (sur un téléphone lent, le re-rendu peut dépasser la fenêtre
          // de détection) : la liste va remonter sous le doigt, un 2e tap ne doit pas retirer
          // le joueur suivant.
          markTransition(600);
          const keep = Object.assign({}, p);
          const r = Store.removePlayer(t.id, p.id);
          if (r.error) { toast(r.error, "err"); return; }
          redraw();
          toast(keep.name + " retiré", "", { label: "Annuler", fn: () => { Store.addPlayer(t.id, keep.name, { club: keep.club, rating: keep.rating, note: keep.note }); redraw(); } });
        };
        ol.appendChild(li);
      });
      card.querySelector(".clear-all").onclick = () => {
        ask({ title: "Retirer tous les joueurs ?", text: `Les ${nz(n)} joueurs inscrits seront retirés de la liste.`, ok: "Tout retirer", cancel: "Garder la liste", danger: true }).then((ok) => {
          if (!ok) return;
          const cur = Store.getTournament(t.id);
          cur.players.map((x) => x.id).forEach((pid) => Store.removePlayer(t.id, pid));
          redraw();
          toast("Liste vidée.");
        });
      };
    }
    return card;
  }

  function openPlayerEdit(tid, pid, after) {
    const t = Store.getTournament(tid);
    const p = t && t.players.find((x) => x.id === pid);
    if (!p) return;
    const body = el(`<div class="form-stack">
      ${field("Nom", `<input type="text" name="name" value="${esc(p.name)}" maxlength="80" />`)}
      <div class="form-grid">
        ${field("Club / ville", `<input type="text" name="club" value="${esc(p.club || "")}" placeholder="Optionnel" />`)}
        ${field("Classement", `<input type="text" name="rating" value="${esc(p.rating || "")}" placeholder="Optionnel" />`)}
      </div>
      ${field("Note", `<textarea name="note" rows="2" placeholder="Optionnel">${esc(p.note || "")}</textarea>`)}
    </div>`);
    const save = (close) => {
      const data = { name: body.querySelector("[name=name]").value, club: body.querySelector("[name=club]").value.trim(), rating: body.querySelector("[name=rating]").value.trim(), note: body.querySelector("[name=note]").value.trim() };
      const cur = Store.getTournament(tid);
      const dup = cur && data.name.trim() && cur.players.some((x) => x.id !== pid && norm(x.name.trim()) === norm(data.name.trim().replace(/\s+/g, " ")));
      const r = Store.updatePlayer(tid, pid, data);
      if (r.error) { toast(r.error, "err"); return; }
      close();
      if (dup) toast("Attention : « " + r.player.name + " » porte le même nom qu’un autre joueur (doublon).", "warn", null, { ms: 5000 });
      else toast("Joueur modifié.");
      if (after) after(); else refresh();
    };
    const m = modal({ title: "Modifier le joueur", body: [body], actions: [{ label: "Annuler", cls: "subtle", onClick: (c) => c() }, { label: "Enregistrer", onClick: save }] });
    m.onEnter = () => save(m.close);
  }

  function playersAfter(tid) {
    const t = Store.getTournament(tid);
    const st = Store.state(t);
    const nScores = countDone(realMatches(st.all));
    const info = el(`<div class="info-banner">
      <span class="ico">🔒</span>
      <div class="ib-txt"><strong>Tirage effectué — inscriptions closes.</strong><br/><span class="muted">${plural(t.players.length, "joueur")} · ${plural(nScores, "match joué", "matchs joués")} sur ${nz(st.progress.total)}${st.exempt ? " · exempt : " + esc(pname(t, st.exempt)) : ""}</span></div>
    </div>`);
    if (!nScores) {
      const b = el('<button type="button" class="btn subtle sm">Modifier la liste</button>');
      b.onclick = () => ask({ title: "Modifier la liste des joueurs ?", text: "Le tirage au sort sera annulé (aucun score n’a encore été saisi). Il faudra relancer le tirage ensuite.", ok: "Annuler le tirage et modifier", cancel: "Garder le tirage" }).then((ok) => {
        if (!ok) return;
        Store.resetDraw(tid);
        refresh();
        toast("Tirage annulé — vous pouvez modifier la liste.");
      });
      info.appendChild(b);
    }
    $app.appendChild(info);

    const search = el(`<div class="search-bar"><input type="search" placeholder="Filtrer les joueurs…" value="${esc(ui.plq)}" aria-label="Filtrer les joueurs" /></div>`);
    $app.appendChild(search);
    const tableCard = el('<section class="card flush"></section>');
    $app.appendChild(tableCard);

    const rows = t.players.map((p) => {
      const s = Store.playerStats(t, p.id);
      return { p, s, status: Store.playerStatus(t, p.id) };
    }).sort((a, b) => (b.s.wins - a.s.wins) || (b.s.pointsFor - a.s.pointsFor) || ((b.s.pointsFor - b.s.pointsAgainst) - (a.s.pointsFor - a.s.pointsAgainst)) || a.p.name.localeCompare(b.p.name, "fr"));

    const counts = {};
    t.players.forEach((p) => { const k = norm(p.name); counts[k] = (counts[k] || 0) + 1; });
    function draw() {
      const q = norm(ui.plq);
      const list = rows.filter((r) => !q || norm(r.p.name).includes(q));
      tableCard.innerHTML = `<table class="table rank-table"><thead><tr><th class="rank">#</th><th>Joueur</th><th class="num">J</th><th class="num">V</th><th class="num">Pts</th><th class="num hide-mobile">Diff.</th></tr></thead><tbody></tbody></table>`;
      const tb = tableCard.querySelector("tbody");
      list.forEach((r) => {
        const c = chipFor(st, r.p.id, r.status);
        const diff = r.s.pointsFor - r.s.pointsAgainst;
        const tr = el(`<tr class="clickable">
          <td class="rank">${nz(rows.indexOf(r) + 1)}</td>
          <td><div class="pl-cell"><strong>${esc(r.p.name)}</strong>${pillHtml(c[0], c[1])}${counts[norm(r.p.name)] > 1 ? pillHtml("warn sm", "doublon") : ""}</div></td>
          <td class="num">${nz(r.s.played)}</td><td class="num">${nz(r.s.wins)}</td><td class="num">${nz(r.s.pointsFor)}</td>
          <td class="num hide-mobile">${signed(diff)}</td></tr>`);
        tr.onclick = () => openPlayerCard(tid, r.p.id);
        tb.appendChild(tr);
      });
      if (!list.length) tb.appendChild(el('<tr><td colspan="6" class="muted center">Aucun joueur ne correspond.</td></tr>'));
    }
    search.querySelector("input").addEventListener("input", (e) => { ui.plq = e.target.value; draw(); });
    draw();
  }

  function openPlayerCard(tid, pid) {
    const t = Store.getTournament(tid);
    if (!t) return;
    const st = Store.state(t);
    const p = t.players.find((x) => x.id === pid);
    if (!p) return;
    const s = Store.playerStatus(t, pid);
    const info = statusInfo(t, st, pid, s);
    const stats = Store.playerStats(t, pid);
    const hist = st.all.filter((m) => m.status === "done" && !m.bye && (m.p1 === pid || m.p2 === pid));
    const histHtml = hist.length ? `<div class="hist">${hist.map((m) => {
      const mine = m.p1 === pid ? m.score1 : m.score2, opp = m.p1 === pid ? m.score2 : m.score1;
      const won = m.winner === pid;
      return `<div class="hist-row"><span class="res ${won ? "w" : "l"}">${won ? "V" : "D"}</span><span class="hr-main"><span class="nm">${esc(pname(t, m.p1 === pid ? m.p2 : m.p1))}</span><small>${esc(stageLabel(st, m, true))}</small></span><span class="sc">${nz(mine)}–${nz(opp)}</span></div>`;
    }).join("")}</div>` : '<p class="muted small">Aucun match joué pour l’instant.</p>';
    const body = [
      el(statusCardHtml(info)),
      el(`<div class="stat-row compact"><div class="stat"><div class="n">${nz(stats.played)}</div><div class="l">Joués</div></div><div class="stat"><div class="n">${nz(stats.wins)}</div><div class="l">Victoires</div></div><div class="stat"><div class="n">${nz(stats.pointsFor)}</div><div class="l">Points</div></div><div class="stat"><div class="n">${signed(stats.pointsFor - stats.pointsAgainst)}</div><div class="l">Diff.</div></div></div>`),
      el(`<div>${histHtml}</div>`),
    ];
    const actions = [{ label: "Modifier le nom", cls: "subtle", onClick: (c) => { c(); openPlayerEdit(tid, pid); } }];
    if (s.kind === "play") actions.push({ label: "Saisir le score", onClick: (c) => { c(); openScore(tid, s.match.id); } });
    else actions.push({ label: "Fermer", onClick: (c) => c() });
    modal({ title: p.name, cls: "player-modal", body, actions });
  }

  // ============================================================
  //  VUE : Scores (table d'arbitrage)
  // ============================================================
  route("/t/:id/scores", function (p) {
    const t = Store.getTournament(p.id);
    if (!t) return notFound();
    const st = shell(t, "scores");
    const tid = t.id;
    if (!st.drawn) {
      const e = el(`<div class="card empty"><div class="ico">🎲</div><h2>Tirage pas encore effectué</h2><p>Inscrivez les joueurs puis lancez le tirage au sort.</p><a class="btn" href="#/t/${encodeURIComponent(tid)}/players">Aller aux inscriptions</a></div>`);
      $app.appendChild(e);
      return;
    }
    const banners = championBanners(t, st);
    if (banners) $app.appendChild(el(`<div class="banners">${banners}</div>`));
    $app.appendChild(progressCard(t, st));

    if (ui.qTid !== tid) { ui.q = ""; ui.qTid = tid; }
    const search = el(`<div class="search-bar"><input type="search" placeholder="Trouver un joueur…" value="${esc(ui.q)}" aria-label="Trouver un joueur" /></div>`);
    const found = el('<div class="found"></div>');
    const readySec = el('<section class="sec ready-sec"></section>');
    $app.appendChild(search);
    $app.appendChild(found);
    $app.appendChild(readySec);

    const sInput = search.querySelector("input");
    function setQuery(v) { ui.q = v; ui.qTid = tid; if (sInput.value !== v) sInput.value = v; drawDynamic(); }
    function drawDynamic() {
      const q = norm(ui.q.trim());
      // Joueurs trouvés
      clear(found);
      if (q) {
        const hits = t.players.filter((x) => norm(x.name).includes(q)).slice(0, 6);
        if (!hits.length) found.appendChild(el('<p class="muted small pad">Aucun joueur ne correspond.</p>'));
        hits.forEach((pl) => {
          const s = Store.playerStatus(t, pl.id);
          const info = statusInfo(t, st, pl.id, s);
          const c = chipFor(st, pl.id, s);
          const card = el(`<div class="found-card"><div class="fc-head"><b>${esc(pl.name)}</b>${pillHtml(c[0], c[1])}</div>${statusCardHtml(info)}</div>`);
          if (s.kind === "play") {
            const b = el('<button class="btn block" type="button">Saisir le score de ce match</button>');
            b.onclick = () => openScore(tid, s.match.id);
            card.appendChild(b);
          }
          found.appendChild(card);
        });
      }
      // À jouer maintenant
      let ready = st.all.filter((m) => m.status === "ready");
      const total = ready.length;
      if (q) ready = ready.filter((m) => norm(pname(t, m.p1)).includes(q) || norm(pname(t, m.p2)).includes(q));
      const waiting = st.all.filter((m) => m.status === "pending" && !m.bye).length;
      readySec.innerHTML = sectionTitle("À jouer maintenant", `<span class="count-badge gold">${nz(total)}</span>`) +
        `<p class="sec-sub muted">${waiting ? plural(waiting, "match", "matchs") + " en attente d’un adversaire" : (total ? "Tous les adversaires sont connus" : "")}</p>`;
      if (q) {
        // Filtre actif : bien visible, effaçable en un tap.
        const chip = el(`<div class="filter-chip" role="status"><span>Filtre « <b>${esc(ui.q.trim())}</b> » · ${plural(ready.length, "match affiché", "matchs affichés")} sur ${nz(total)}</span><button type="button" class="fc-clear">Tout afficher ✕</button></div>`);
        chip.querySelector(".fc-clear").onclick = () => setQuery("");
        readySec.appendChild(chip);
      }
      const list = el('<div class="ready-list"></div>');
      if (!ready.length) {
        const allDone = st.progress.total > 0 && st.progress.played === st.progress.total;
        list.appendChild(el(`<div class="empty slim"><p>${q ? "Aucun match à jouer pour ce joueur." : allDone ? "Tous les matchs sont joués. 🎉" : "Aucun match prêt : en attente de résultats."}</p></div>`));
      }
      ready.forEach((m) => {
        const stg = m.stage === "p1" || m.stage === "main" || m.stage === "cons" ? m.stage : "x";
        const row = el(`<button type="button" class="match-row stage-${stg}" data-match="${esc(m.id)}">
          <span class="mr-stage"><span class="stage-chip ${stg}">${esc(m.stage === "p1" && !m.isFinal ? "Phase 1 · " + (nz(m.index) + 1) : stageLabel(st, m))}</span></span>
          <span class="mr-players"><span class="mr-p">${esc(pname(t, m.p1))}</span><span class="mr-p b"><span class="vs">vs</span>${esc(pname(t, m.p2))}</span></span>
          <span class="mr-pts">en ${plural(m.points, "pt").replace(" ", "&nbsp;")}</span>
          <span class="mr-go" aria-hidden="true">›</span>
        </button>`);
        row.onclick = () => openScore(tid, m.id);
        list.appendChild(row);
      });
      readySec.appendChild(list);
    }
    sInput.addEventListener("input", (e) => { ui.q = e.target.value; ui.qTid = tid; drawDynamic(); });
    drawDynamic();

    const recent = recentCard(t, st);
    if (recent) $app.appendChild(recent);
    const rep = repechageCard(t, st);
    if (rep) $app.appendChild(rep);
  });

  function progRow(label, done, total, note, cls) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return `<div class="prog ${cls || ""}"><div class="prog-head"><span class="prog-label">${label}</span><span class="prog-val">${note != null ? note : `${nz(done)}<small>/${nz(total)}</small>`}</span></div><div class="bar"><i style="width:${nz(pct)}%"></i></div></div>`;
  }

  function progressCard(t, st) {
    const rows = [];
    if (st.main.size === 1) {
      rows.push(progRow("Finale", st.phase1.played, 1, null, st.champion ? "done" : ""));
    } else {
      rows.push(progRow("Phase 1", st.phase1.played, st.phase1.total, null, st.phase1.done ? "done" : ""));
      const mm = realMatches([].concat.apply([], st.main.rounds));
      rows.push(progRow("Tableau final" + (st.main.size ? ` · ${nz(st.main.size)}` : ""), countDone(mm), mm.length, null, st.champion ? "done" : ""));
      if (st.consolante) {
        const cm = realMatches([].concat.apply([], st.consolante.rounds));
        rows.push(progRow(`Consolante · ${nz(st.consolante.entrants.length)}`, countDone(cm), cm.length, null, st.consolante.champion ? "done" : ""));
      } else if (t.settings.consolante !== false && st.plan.ok && st.plan.consolante >= 2) {
        rows.push(progRow("Consolante", 0, 1, `<small>après la phase 1 · ${nz(st.plan.consolante)} joueurs</small>`, "later"));
      }
    }
    return el(`<section class="card progress-card">${rows.join("")}</section>`);
  }

  function championBanners(t, st) {
    let h = "";
    if (st.champion) h += `<div class="champ-banner"><img src="${LOGO}" alt="" class="crest" /><div><div class="cb-eyebrow">Champion du tournoi</div><div class="cb-name">🏆 ${esc(pname(t, st.champion))}</div></div></div>`;
    if (st.consolante && st.consolante.champion) h += `<div class="champ-banner small"><span class="cb-cup">🏆</span><div><div class="cb-eyebrow">Vainqueur de la consolante</div><div class="cb-name">${esc(pname(t, st.consolante.champion))}</div></div></div>`;
    return h;
  }

  function recentCard(t, st) {
    const done = realMatches(st.all).filter((m) => m.status === "done").sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 5);
    if (!done.length) return null;
    const card = el(`<section class="sec">${sectionTitle("Derniers résultats")}<div class="recent-list"></div><a class="more-link" href="#/t/${encodeURIComponent(t.id)}/settings#corrections">Toutes les corrections ›</a></section>`);
    const list = card.querySelector(".recent-list");
    done.forEach((m) => {
      const w1 = m.winner === m.p1;
      const row = el(`<button type="button" class="recent-row">
        <span class="rr-stage">${esc(stageLabel(st, m))}</span>
        <span class="rr-score"><b>${esc(pname(t, m.winner))}</b> <span class="sc">${nz(w1 ? m.score1 : m.score2)}–${nz(w1 ? m.score2 : m.score1)}</span> <span class="lo">${esc(pname(t, m.loser))}</span></span>
        <span class="rr-time">${esc(ago(m.at))}</span>
        <span class="rr-edit">Corriger</span>
      </button>`);
      row.onclick = () => openScore(t.id, m.id, { overwrite: true });
      list.appendChild(row);
    });
    return card;
  }

  function repechageCard(t, st) {
    const R = st.repechage.needed;
    if (!R || st.main.size <= 1) return null;
    const rk = st.repechage.ranking;
    const remaining = st.phase1.total - st.phase1.played;
    const final = st.repechage.resolved;
    const consOn = t.settings.consolante !== false;
    const consWill = final ? !!st.consolante : (consOn && st.plan.ok && st.plan.consolante >= 2);
    const consSet = {};
    if (st.consolante) st.consolante.entrants.forEach((p) => { consSet[p] = true; });
    const card = el(`<section class="card rep-card">
      ${sectionTitle("Repêchage", final ? pillHtml("ok", "Définitif") : pillHtml("warn", "Provisoire"))}
      <p class="muted small">${plural(R, "place")} au tableau final pour les meilleurs perdants de la phase 1 · classement : points marqués, puis différentiel, puis tirage au sort.${final ? "" : ` <b>${plural(remaining, "match", "matchs")} de phase 1 restant${remaining > 1 ? "s" : ""}.</b>`}</p>
      <div class="table-wrap"><table class="table rep-table"><colgroup><col class="c-rank"/><col/><col class="c-num"/><col class="c-num"/></colgroup><thead><tr><th class="rank" title="Rang">#</th><th>Perdant</th><th class="num">Pts</th><th class="num">Diff.</th></tr></thead><tbody></tbody></table></div>
    </section>`);
    const tb = card.querySelector("tbody");
    if (!rk.length) tb.appendChild(el('<tr><td colspan="4" class="muted center">Aucun perdant pour l’instant.</td></tr>'));
    rk.forEach((x, i) => {
      let tag = "";
      if (x.picked) tag = pillHtml("gold sm", "Repêché");
      else if (x.inZone) tag = '<span class="star" title="Dans la zone pour l’instant">★</span>';
      else if (final) tag = consSet[x.pid] ? pillHtml("cons sm", "Consolante") : pillHtml("out sm", "Éliminé");
      tb.appendChild(el(`<tr class="${x.inZone ? "in" : "outz"}">
        <td class="rank">${nz(x.rank)}</td><td class="rep-name"><span class="rn">${esc(pname(t, x.pid))}</span>${tag}</td><td class="num"><b>${nz(x.pf)}</b></td><td class="num">${signed(x.diff)}</td></tr>`));
      if (i === R - 1) tb.appendChild(el(`<tr class="cut"><td colspan="4"><span>Ligne de repêchage · ${plural(R, "place")}${consWill ? " — en dessous : consolante" : ""}</span></td></tr>`));
    });
    if (rk.length && rk.length < R) tb.appendChild(el(`<tr class="cut open"><td colspan="4"><span>${plural(R - rk.length, "place encore libre", "places encore libres")}</span></td></tr>`));
    return card;
  }

  // ============================================================
  //  Saisie d'un score (modale) + pop-up de résultat
  // ============================================================
  /** Simulation d'une correction (s1/s2) ou d'un effacement (s1 = null) — voir Store.simulate. */
  function simulateChange(tid, matchId, a, b) {
    const t = Store.getTournament(tid);
    if (!t || !t.draw || typeof Store.simulate !== "function") return null;
    try { return Store.simulate(t, matchId, a, b); } catch (e) { console.error(e); return null; }
  }
  /** Une confirmation est-elle obligatoire ? (tout effet au-delà du match lui-même) */
  function needsConfirm(d) { return !!d && (!d.none || d.championChanged); }

  /** Joueurs à prévenir après une correction (hors les deux joueurs du match corrigé). */
  function playersToCall(t, d, exclude) {
    if (!d) return [];
    const ex = {}; (exclude || []).forEach((p) => { ex[p] = true; });
    const out = [], seen = {};
    const add = (p) => { if (p && p !== "BYE" && !ex[p] && !seen[p]) { seen[p] = true; out.push(p); } };
    d.picksOut.forEach(add); d.picksIn.forEach(add);
    d.reassigned.forEach((r) => { r.before.forEach(add); r.after.forEach(add); });
    d.cancelled.forEach((m) => { add(m.p1); add(m.p2); });
    return out;
  }

  /** Texte complet des conséquences d'une correction / d'un effacement (HTML, noms échappés). */
  function impactSummaryHtml(t, st, d, subject, newWinner) {
    if (!d) return "";
    const N = (pid) => (pid && pid !== "BYE" ? `<b>${esc(pname(t, pid))}</b>` : pid === "BYE" ? "exempt" : "<i>à déterminer</i>");
    const names = (l) => l.map(N).join(", ");
    const pair = (p) => `${N(p[0])} – ${N(p[1])}`;
    const items = [];
    if (d.phase1Reopened) {
      items.push(`<li><b>La phase 1 sera rouverte</b>${d.picksOut.length ? ` : repêchés annulés (${names(d.picksOut)})` : ""}${d.consolanteRemoved ? ", consolante retirée" : ""}.</li>`);
    } else {
      // Le nouveau vainqueur du match corrigé n'est plus repêché : il est qualifié par sa victoire.
      const out = d.picksOut.filter((p) => p !== newWinner);
      if (out.length) items.push(`<li>${names(out)} ${out.length > 1 ? "perdent leur place" : "perd sa place"} de repêché.</li>`);
      if (newWinner && d.picksOut.indexOf(newWinner) >= 0) items.push(`<li>${N(newWinner)} n’est plus repêché : qualifié par sa victoire.</li>`);
      if (d.consolanteRemoved) items.push("<li>La consolante est retirée de tous les écrans.</li>");
    }
    if (d.phase1Completed) items.push("<li>La phase 1 sera terminée.</li>");
    if (d.picksIn.length) items.push(`<li>${names(d.picksIn)} ${d.picksIn.length > 1 ? "deviennent repêchés" : "devient repêché"}.</li>`);
    if (d.consolanteCreated) items.push("<li>La consolante sera lancée.</li>");
    if (d.consolanteChanged) items.push("<li>La consolante est redistribuée (ses joueurs changent).</li>");
    if (d.championChanged) items.push("<li>Le champion change.</li>");
    let h = "";
    if (items.length) h += `<ul class="im-main">${items.join("")}</ul>`;
    if (d.cancelled.length) {
      const li = d.cancelled.slice(0, 8).map((m) => `<li><span class="im-stage">${esc(stageLabel(st, m))}</span> ${N(m.p1)} <b>${nz(m.score1)}–${nz(m.score2)}</b> ${N(m.p2)}</li>`).join("");
      h += `<div class="im-sub">${plural(d.cancelled.length, "match déjà joué ne comptera plus", "matchs déjà joués ne compteront plus")} :</div><ul>${li}${d.cancelled.length > 8 ? `<li>… et ${d.cancelled.length - 8} autre(s)</li>` : ""}</ul><div class="impact-note">Leurs scores sont gardés : ils reviennent si le même résultat est ressaisi.</div>`;
    }
    // Matchs de consolante qui disparaissent (consolante retirée) : résumés en une ligne.
    const gone = d.reassigned.filter((r) => r.match.stage === "cons" && !r.after[0] && !r.after[1]);
    const moved = d.reassigned.filter((r) => gone.indexOf(r) < 0);
    if (gone.length) h += `<div class="im-sub">${plural(gone.length, "match de consolante à jouer est retiré", "matchs de consolante à jouer sont retirés")} : ${gone.slice(0, 6).map((r) => pair(r.before)).join(", ")}${gone.length > 6 ? " …" : ""}.</div>`;
    if (moved.length) {
      const li = moved.slice(0, 8).map((r) => `<li><span class="im-stage">${esc(stageLabel(st, r.match))}</span> ${pair(r.before)} <span class="im-arrow">→</span> ${pair(r.after)}</li>`).join("");
      h += `<div class="im-sub">${plural(moved.length, "match à jouer change", "matchs à jouer changent")} de joueurs :</div><ul>${li}${moved.length > 8 ? `<li>… et ${moved.length - 8} autre(s)</li>` : ""}</ul>`;
    }
    if (!h) return "";
    return `<div class="impact"><div class="impact-title">⚠ ${esc(subject)} a d’autres conséquences</div>${h}</div>`;
  }

  function openScore(tid, matchId, opts) {
    opts = opts || {};
    const t0 = Store.getTournament(tid);
    if (!t0) return;
    const st0 = Store.state(t0);
    const m = st0.byId[matchId];
    if (!m) { toast("Match introuvable.", "err"); return; }
    const overwrite = !!opts.overwrite;
    if (m.bye) { toast("Match d’exempt : rien à saisir.", "err"); return; }
    if (m.status === "pending") { toast("Ce match n’est pas encore prêt : l’adversaire n’est pas connu.", "err"); return; }
    if (m.status === "done" && !overwrite) { toast("Ce match a déjà un résultat (voir Corrections).", "err"); return; }
    const P = [m.p1, m.p2];
    const names = P.map((pid) => pname(t0, pid));
    const target = nz(m.points);
    const v = m.status === "done" ? [nz(m.score1), nz(m.score2)] : [0, 0];
    const orig = v.slice();

    const titleHtml = `<div class="sm-stage">${esc(stageLabel(st0, m, true))}</div><h3>${overwrite ? "Corriger le score" : "Saisir le score"}</h3><div class="sm-target">Match en <b>${nz(target)}</b> ${nz(target) > 1 ? "points" : "point"}</div>`;
    const rows = P.map((pid, i) => el(`<div class="sm-row">
      <div class="sm-name"><span class="nm">${esc(names[i])}</span><span class="win-tag">Vainqueur</span></div>
      <div class="sm-ctrl">
        <button type="button" class="target-chip" tabindex="-1" title="Mettre ${target} points" aria-label="${esc(names[i])} : ${target} points">${target}</button>
        <div class="stepper big">
          <button type="button" class="minus" tabindex="-1" aria-label="Moins">−</button>
          <input type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="99" value="${v[i]}" aria-label="Score de ${esc(names[i])}" />
          <button type="button" class="plus" tabindex="-1" aria-label="Plus">+</button>
        </div>
      </div></div>`));
    const hint = el('<div class="sm-hint" aria-live="polite"></div>');
    const impact = el('<div class="sm-impact"></div>');
    const saveBtn = el('<button type="button" class="btn big block save-btn">Enregistrer</button>');
    const md = modal({
      titleHtml, cls: "score-modal", body: rows.concat([hint, impact]),
      focus: () => rows[0].querySelector("input"),
    });
    md.foot.appendChild(saveBtn);
    // Clavier : un chiffre tapé alors que le focus est sur la feuille va dans le 1er score.
    md.box.addEventListener("keydown", (e) => {
      if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.target && e.target.tagName === "INPUT")) {
        const inp = rows[0].querySelector("input");
        inp.focus(); inp.select();
      }
    });

    let saving = false;
    let diff = null;
    const unusualOf = (a, b) => Math.max(a, b) < target || Math.min(a, b) >= target || Math.max(a, b) > 2 * target;
    function update(fromInput) {
      rows.forEach((r, i) => {
        const inp = r.querySelector("input");
        if (fromInput !== i) inp.value = v[i];
        r.classList.toggle("win", v[i] > v[1 - i]);
        r.querySelector(".target-chip").classList.toggle("on", v[i] === target);
      });
      const a = v[0], b = v[1];
      hint.className = "sm-hint";
      hint.textContent = "";
      if (a === b) {
        saveBtn.disabled = true;
        saveBtn.textContent = a === 0 ? "Saisissez le score" : "Égalité impossible";
        if (a > 0) { hint.classList.add("err"); hint.textContent = "Pas d’égalité au backgammon : il faut un vainqueur."; }
      } else {
        saveBtn.disabled = saving;
        const w = a > b ? 0 : 1;
        saveBtn.innerHTML = `<span class="sb-fix">Valider ·</span> <span class="sb-name">${esc(names[w])}</span> <span class="sb-fix">gagne ${Math.max(a, b)}–${Math.min(a, b)}</span>`;
        saveBtn.title = `Valider : ${names[w]} gagne ${Math.max(a, b)}–${Math.min(a, b)}`;
        if (Math.max(a, b) < target) { hint.classList.add("warn"); hint.textContent = `Score inhabituel : personne n’a atteint ${target} points.`; }
        else if (Math.min(a, b) >= target) { hint.classList.add("warn"); hint.textContent = `Score inhabituel : les deux joueurs ont ${target} points ou plus.`; }
        else if (Math.max(a, b) > 2 * target) { hint.classList.add("warn"); hint.textContent = `Score inhabituel : ${Math.max(a, b)} points pour un match en ${target} — faute de frappe ?`; }
      }
      if (overwrite) {
        const changed = a !== orig[0] || b !== orig[1];
        diff = changed && a !== b ? simulateChange(tid, matchId, a, b) : null;
        const t = Store.getTournament(tid);
        const html = diff ? impactSummaryHtml(t, Store.state(t), diff, "Ce changement", a > b ? P[0] : P[1]) : "";
        impact.innerHTML = html || (changed && a !== b ? '<div class="impact ok">Aucun autre match n’est affecté.</div>' : "");
        if (!changed) { saveBtn.disabled = true; saveBtn.textContent = "Modifiez le score"; }
      }
    }
    rows.forEach((r, i) => {
      const inp = r.querySelector("input");
      r.querySelector(".minus").onclick = () => { v[i] = Math.max(0, v[i] - 1); update(); };
      r.querySelector(".plus").onclick = () => { v[i] = Math.min(99, v[i] + 1); update(); };
      r.querySelector(".target-chip").onclick = () => {
        v[i] = target;
        // L'autre joueur ne peut pas avoir aussi atteint la cible : on le remet à 0.
        if (v[1 - i] >= target) v[1 - i] = 0;
        update();
      };
      inp.addEventListener("focus", () => inp.select());
      inp.addEventListener("input", () => { const n = parseInt(inp.value, 10); v[i] = Number.isFinite(n) ? Math.max(0, Math.min(99, n)) : 0; update(i); });
      inp.addEventListener("blur", () => { inp.value = v[i]; });
    });

    function doSave() {
      const a = v[0], b = v[1];
      const t = Store.getTournament(tid);
      const cur = t && Store.state(t).byId[matchId];
      if (!cur || cur.p1 !== P[0] || cur.p2 !== P[1]) { md.close(); toast("Ce match a changé entre-temps (autre saisie) : rouvrez-le.", "err"); refresh(); return; }
      if (!overwrite && cur.status === "done") { md.close(); toast("Ce match vient d’être saisi sur un autre appareil.", "err"); refresh(); return; }
      const d = overwrite ? simulateChange(tid, matchId, a, b) : null;
      const r = Store.recordScore(tid, matchId, a, b, { overwrite });
      if (r.error) { saving = false; update(); toast(r.error, "err"); return; }
      ui.q = "";                      // la recherche a servi : on réaffiche toute la liste
      md.close("saved");
      refresh();
      showResult(tid, r.outcome, { corrected: overwrite, impact: d, players: P });
    }
    function save() {
      if (saving) return;
      const a = v[0], b = v[1];
      if (a === b) { hint.className = "sm-hint err"; hint.textContent = "Pas d’égalité au backgammon : il faut un vainqueur."; return; }
      if (saveBtn.disabled) return;
      // Un seul enregistrement par tap : le bouton est verrouillé jusqu'au résultat.
      saving = true;
      saveBtn.disabled = true;
      const unusual = unusualOf(a, b);
      const checks = [];
      if (unusual) checks.push(`<p>Score inhabituel pour un match en <b>${target}</b> points :<br/><b>${esc(names[0])} ${a} – ${b} ${esc(names[1])}</b></p>`);
      let corr = false;
      if (overwrite) {
        diff = simulateChange(tid, matchId, a, b);
        if (needsConfirm(diff)) {
          corr = true;
          const t = Store.getTournament(tid);
          checks.push(`<p>Correction : <b>${esc(names[0])} ${a} – ${b} ${esc(names[1])}</b></p>` + impactSummaryHtml(t, Store.state(t), diff, "Cette correction", a > b ? P[0] : P[1]));
        }
      }
      if (!checks.length) { doSave(); return; }
      ask({ title: corr ? "Confirmer la correction ?" : "Confirmer ce score ?", html: checks.join(""), ok: corr ? "Corriger quand même" : "Confirmer", cancel: "Revenir au score", cls: corr ? "wide" : "" })
        .then((ok) => { if (ok) doSave(); else { saving = false; update(); } });
    }
    saveBtn.onclick = save;
    md.onEnter = save;
    update();
  }

  function confetti(n) {
    let h = "";
    for (let i = 0; i < n; i++) {
      const left = (i * 37) % 100, delay = ((i * 13) % 20) / 10, dur = 2.4 + ((i * 7) % 10) / 10, rot = (i * 47) % 360;
      h += `<i style="left:${left}%;animation-delay:${delay}s;animation-duration:${dur}s;transform:rotate(${rot}deg)"></i>`;
    }
    return `<div class="confetti" aria-hidden="true">${h}</div>`;
  }

  function showResult(tid, o, opts) {
    opts = opts || {};
    const t = Store.getTournament(tid);
    if (!t || !o) return;
    const st = Store.state(t);
    const m = o.match;
    const w1 = m.winner === m.p1;
    const ws = nz(w1 ? m.score1 : m.score2), ls = nz(w1 ? m.score2 : m.score1);
    const W = pname(t, o.winner), L = pname(t, o.loser);
    const pickedNow = (pid) => !!o.phase1Completed || !!(opts.impact && opts.impact.picksIn && opts.impact.picksIn.indexOf(pid) >= 0);
    const wInfo = statusInfo(t, st, o.winner, o.winnerStatus, { justPicked: pickedNow(o.winner) });
    const lInfo = statusInfo(t, st, o.loser, o.loserStatus, { justPicked: pickedNow(o.loser) });
    const parts = [];
    const champ = o.champion || o.consoleChampion;
    if (champ) {
      parts.push(`<div class="celebrate">${confetti(28)}<img src="${LOGO}" alt="" class="crest" /><div class="cel-eyebrow">${o.champion ? "Champion du tournoi" : "Vainqueur de la consolante"}</div><div class="cel-name">🏆 ${esc(pname(t, champ))}</div></div>`);
    }
    parts.push(`<div class="res-head"><span class="res-check">✓</span><div class="res-main"><div class="res-line"><b>${esc(W)}</b> <span class="res-sc">${ws} – ${ls}</span> <span class="lo">${esc(L)}</span></div><div class="res-stage">${esc(stageLabel(st, m, true))} · ${opts.corrected ? "score corrigé" : "résultat enregistré"}</div></div></div>`);
    // Correction : qui faut-il prévenir ?
    if (opts.corrected && opts.impact && needsConfirm(opts.impact)) {
      const call = playersToCall(t, opts.impact, opts.players || [m.p1, m.p2]);
      parts.push(`<div class="call-banner"><div class="cb-title">📣 Joueurs à prévenir</div>${call.length ? `<div class="cb-list">${call.map((pid) => `<span class="chip">${esc(pname(t, pid))}</span>`).join(" ")}</div>` : ""}<div class="cb-note">Leur situation a changé avec cette correction (repêchage, consolante ou adversaire).</div></div>`);
    }
    // Fin de phase 1 : information clé, affichée en haut (pas pour la finale directe à 2 joueurs).
    if (o.phase1Completed && st.main.size > 1) {
      const rp = o.repechage || st.repechage;
      const picks = rp.picks.map((pid) => `<span class="chip gold">${esc(pname(t, pid))}</span>`).join(" ");
      const consTxt = st.consolante ? `Consolante lancée (${nz(st.consolante.entrants.length)} joueurs)` : (t.settings.consolante !== false ? "Pas de consolante (pas assez de joueurs)" : "");
      parts.push(`<div class="p1-done"><div class="p1d-title">Phase 1 terminée !</div><div class="p1d-line">${rp.needed ? `Repêchés (${nz(rp.picks.length)}) : <span class="p1d-chips">${picks}</span>` : "Aucun repêchage : le tableau final est complet."}</div>${consTxt ? `<div class="p1d-line">${esc(consTxt)}</div>` : ""}</div>`);
    }
    parts.push(`<div class="pcard win"><div class="pc-head"><span class="pc-name">${esc(W)}</span>${pillHtml("gold", "Gagne")}</div>${statusCardHtml(wInfo)}</div>`);
    parts.push(`<div class="pcard lose"><div class="pc-head"><span class="pc-name">${esc(L)}</span>${pillHtml("out", "Perd")}</div>${statusCardHtml(lInfo)}</div>`);
    const md = modal({
      title: null, cls: "result-modal" + (champ ? " is-champion" : ""),
      body: parts.map((h) => el(h)),
      guardMs: 650,
      actions: [
        { label: "Voir l’arbre", cls: "subtle", onClick: (c) => {
          c();
          // Ouvre l'arbre de l'étape du match, qui « flashe ».
          tv.tid = tid;
          tv.view = m.stage === "cons" ? "cons" : "main";
          tv.flash = { id: m.id, at: Date.now() };
          navigate("#/t/" + encodeURIComponent(tid) + "/bracket");
        } },
        { label: "Continuer", onClick: (c) => c() },
      ],
    });
    md.onEnter = () => md.close();
    scrollHint(md);
  }

  /** Dégradé en bas d'une modale qui défile (indique qu'il y a une suite). */
  function scrollHint(md) {
    const b = md.body;
    const upd = () => { b.classList.toggle("more-below", b.scrollHeight - b.scrollTop - b.clientHeight > 8); };
    b.addEventListener("scroll", upd, { passive: true });
    setTimeout(upd, 30);
    setTimeout(upd, 400);
  }

  // ============================================================
  //  VUE : Réglages
  // ============================================================
  /**
   * Formulaire des réglages. Tant qu'il contient des modifications non enregistrées
   * (« dirty »), il n'est JAMAIS reconstruit : un changement venu d'un autre appareil
   * redessine le reste de la page mais garde ce formulaire tel quel.
   */
  function buildSettingsForm(t, st, K) {
    const tid = t.id;
    const s = t.settings;
    const F = { tid, K, dirty: false, remoteSeen: false, node: null, saving: false };
    // Valeurs à l'ouverture du formulaire : on n'enregistrera QUE les champs réellement
    // modifiés ici, pour ne jamais écraser un réglage changé entre-temps sur un autre appareil.
    const base = {
      name: t.name, date: t.date || "",
      pointsPhase1: s.pointsPhase1, mainPoints: s.mainPoints.slice(), consolePoints: s.consolePoints,
      consolante: !!s.consolante, autoRotate: !!s.autoRotate, rotateSeconds: s.rotateSeconds, rules: s.rules || "",
    };
    const node = el('<div class="settings-form"><div class="sf-banner" hidden></div></div>');
    F.node = node;
    const banner = node.querySelector(".sf-banner");
    const markDirty = () => { if (!F.dirty) { F.dirty = true; F.refresh(); } };

    // --- Informations ---
    const infoC = el(`<section class="card">${sectionTitle("Informations")}<div class="form-grid">
      ${field("Nom du tournoi", `<input type="text" name="name" value="${esc(t.name)}" maxlength="80" />`)}
      ${field("Date", `<input type="date" name="date" value="${esc(t.date || "")}" />`)}
    </div></section>`);
    node.appendChild(infoC);

    // --- Points ---
    const ptsC = el(`<section class="card">${sectionTitle("Points par match")}<p class="muted small">Nombre de points à atteindre pour gagner un match. ${st.drawn ? "Tours du tableau tiré au sort." : st.plan.ok ? "Tours prévus pour " + plural(t.players.length, "joueur") + "." : "Les tours affichés s’adapteront au nombre de joueurs."}</p><div class="num-grid"></div></section>`);
    const grid = ptsC.querySelector(".num-grid");
    const fP1 = numField("Phase 1", s.pointsPhase1, 1, 99, null, markDirty);
    if (K > 0) grid.appendChild(fP1.node);
    const roundFields = [];
    if (K === 0) {
      const f = numField("Finale (match unique)", s.mainPoints[0], 1, 99, null, markDirty);
      roundFields.push({ idx: 0, f });
      grid.appendChild(f.node);
    } else {
      for (let r = 1; r <= K; r++) {
        const f = numField(Store.roundName(K, r), s.mainPoints[K - r], 1, 99, null, markDirty);
        roundFields.push({ idx: K - r, f });
        grid.appendChild(f.node);
      }
    }
    const fCons = numField("Consolante (tous les tours)", s.consolePoints, 1, 99, null, markDirty);
    grid.appendChild(fCons.node);
    node.appendChild(ptsC);

    // --- Format & affichage ---
    const fmtC = el(`<section class="card">${sectionTitle("Consolante & affichage")}
      <label class="toggle"><input type="checkbox" name="consolante" ${s.consolante ? "checked" : ""}/><span class="track"></span><span class="tg-txt">Consolante<small>Les perdants non repêchés jouent un second tableau, lancé automatiquement à la fin de la phase 1.</small></span></label>
      <hr class="divider"/>
      <label class="toggle"><input type="checkbox" name="autoRotate" ${s.autoRotate ? "checked" : ""}/><span class="track"></span><span class="tg-txt">Rotation automatique des arbres<small>L’écran public alterne entre l’arbre principal et la consolante.</small></span></label>
      <div class="rot-secs"></div>
    </section>`);
    const fRot = numField("Durée d’affichage de chaque arbre (secondes)", s.rotateSeconds, 5, 99, null, markDirty);
    fmtC.querySelector(".rot-secs").appendChild(fRot.node);
    node.appendChild(fmtC);

    // --- Règlement ---
    const rulesC = el(`<section class="card">${sectionTitle("Règlement")}<textarea name="rules" rows="5">${esc(s.rules || "")}</textarea></section>`);
    node.appendChild(rulesC);

    [infoC, fmtC, rulesC].forEach((c) => { c.addEventListener("input", markDirty); c.addEventListener("change", markDirty); });

    const saveBar = el(`<div class="save-bar"><span class="sb-dirty" hidden>Modifications non enregistrées</span><button class="btn subtle discard" type="button" title="Annuler les modifications" hidden>Annuler</button><button class="btn big save" type="button">Enregistrer les réglages</button></div>`);
    const saveBtn = saveBar.querySelector(".save"), discardBtn = saveBar.querySelector(".discard");
    node.appendChild(saveBar);

    F.refresh = () => {
      saveBar.classList.toggle("dirty", F.dirty);
      saveBar.querySelector(".sb-dirty").hidden = !F.dirty;
      discardBtn.hidden = !F.dirty;
      banner.hidden = !(F.dirty && F.remoteSeen);
      banner.innerHTML = F.dirty && F.remoteSeen ? '<span class="ico">⟳</span><span>Des données ont changé ailleurs — vos modifications non enregistrées sont conservées.</span>' : "";
    };
    discardBtn.onclick = () => {
      F.dirty = false;
      if (settingsForm === F) settingsForm = null;
      refresh();
      toast("Modifications annulées.");
    };
    saveBtn.onclick = () => {
      if (F.saving) return;
      const cur = Store.getTournament(tid);
      if (!cur) return;
      // Patch = uniquement les champs modifiés dans CE formulaire (base = valeurs à l'ouverture).
      const patch = { settings: {} };
      const nameV = infoC.querySelector("[name=name]").value, dateV = infoC.querySelector("[name=date]").value;
      if (nameV !== base.name) patch.name = nameV;
      if (dateV !== base.date) patch.date = dateV;
      const setIf = (k, v) => { if (v !== base[k]) patch.settings[k] = v; };
      setIf("pointsPhase1", fP1.get());
      setIf("consolePoints", fCons.get());
      setIf("consolante", fmtC.querySelector("[name=consolante]").checked);
      setIf("autoRotate", fmtC.querySelector("[name=autoRotate]").checked);
      setIf("rotateSeconds", fRot.get());
      setIf("rules", rulesC.querySelector("[name=rules]").value);
      const mp = cur.settings.mainPoints.slice();
      let mpChanged = false;
      roundFields.forEach((x) => { const v = x.f.get(); if (v !== base.mainPoints[x.idx]) { mp[x.idx] = v; mpChanged = true; } });
      if (mpChanged) patch.settings.mainPoints = mp;
      const nothing = patch.name == null && patch.date == null && !Object.keys(patch.settings).length;
      const doSave = () => {
        F.saving = true;
        saveBtn.disabled = true;
        if (!nothing) Store.updateTournament(tid, patch);
        F.dirty = false; F.remoteSeen = false;
        if (settingsForm === F) settingsForm = null;
        if (document.activeElement) document.activeElement.blur();
        refresh();
        toast(nothing ? "Aucune modification à enregistrer." : "Réglages enregistrés ✓");
      };
      // Couper une consolante déjà lancée : elle disparaît de tous les écrans → confirmation.
      const cst = Store.state(cur);
      if (cur.settings.consolante !== false && patch.settings.consolante === false && cst.consolante) {
        const cm = realMatches([].concat.apply([], cst.consolante.rounds));
        const played = countDone(cm), ready = cm.filter((m) => m.status === "ready").length;
        ask({
          title: "Désactiver la consolante ?",
          html: `<p>La consolante en cours (${plural(cst.consolante.entrants.length, "joueur")} · <b>${plural(played, "match joué", "matchs joués")}</b>${ready ? ` · ${plural(ready, "match à jouer", "matchs à jouer")}` : ""}) disparaîtra de tous les écrans : arbre, scores, corrections.</p><p class="muted">Les scores déjà saisis sont gardés : ils reviennent si vous réactivez la consolante.</p>`,
          ok: "Désactiver la consolante", cancel: "Garder la consolante", danger: true,
        }).then((ok) => { if (ok) doSave(); });
        return;
      }
      doSave();
    };
    F.refresh();
    return F;
  }

  route("/t/:id/settings", function (p) {
    const t = Store.getTournament(p.id);
    if (!t) return notFound();
    const st = shell(t, "settings");
    const tid = t.id;
    const K = st.drawn ? st.main.totalRounds : (st.plan.ok ? st.plan.mainRounds : 3);

    // --- Formulaire (conservé tel quel s'il a des modifications non enregistrées) ---
    let F = settingsForm;
    if (!(F && F.tid === tid && F.dirty && F.K === K)) {
      if (F && F.tid === tid && F.dirty) toast("Le format du tableau a changé ailleurs : vos réglages non enregistrés ont été abandonnés.", "warn", null, { ms: 6000 });
      F = settingsForm = buildSettingsForm(t, st, K);
    }
    F.refresh();
    $app.appendChild(F.node);

    // --- Tirage ---
    const drawC = el(`<section class="card">${sectionTitle("Tirage au sort")}</section>`);
    if (t.draw) {
      const n = countDone(realMatches(st.all));
      drawC.appendChild(el(`<p class="muted">Tirage effectué le ${esc(new Date(nz(t.draw.at)).toLocaleDateString("fr-FR"))} à ${esc(fmtTime(nz(t.draw.at)))} · ${plural(t.draw.n, "joueur")} · <b>${plural(n, "score saisi", "scores saisis")}</b></p>`));
      const row = el('<div class="btn-row"></div>');
      const redo = el('<button class="btn subtle" type="button">🎲 Refaire le tirage</button>');
      const undo = el('<button class="btn danger" type="button">Annuler le tirage</button>');
      redo.onclick = () => ask({ title: "Refaire le tirage ?", html: `<p>Un nouveau tirage au sort recompose toutes les paires.${n ? ` <b>Les ${plural(n, "score saisi", "scores saisis")} seront effacés.</b>` : ""}</p>`, ok: "Refaire le tirage", cancel: "Garder ce tirage", danger: n > 0 }).then((ok) => {
        if (!ok) return;
        const r = Store.drawTournament(tid);
        if (r.error) toast(r.error, "err"); else { refresh(); toast("Nouveau tirage effectué."); }
      });
      undo.onclick = () => ask({ title: "Annuler le tirage ?", html: `<p>Retour aux inscriptions (la liste des joueurs redevient modifiable).${n ? ` <b>Les ${plural(n, "score saisi", "scores saisis")} seront effacés.</b>` : ""}</p>`, ok: "Annuler le tirage", cancel: "Garder le tirage", danger: true }).then((ok) => {
        if (!ok) return;
        Store.resetDraw(tid);
        refresh();
        toast("Tirage annulé.");
      });
      row.appendChild(redo); row.appendChild(undo);
      drawC.appendChild(row);
    } else {
      drawC.appendChild(el(`<p class="muted">Pas encore de tirage. ${esc(planInfo(t, t.players.length).text)}</p>`));
      drawC.appendChild(el(`<a class="btn subtle" href="#/t/${encodeURIComponent(tid)}/players">Aller aux inscriptions</a>`));
    }
    $app.appendChild(drawC);

    // --- Corrections ---
    if (t.draw) $app.appendChild(correctionsCard(t, st));

    // --- Cloud ---
    $app.appendChild(cloudCard());

    // --- Sauvegarde & suppression ---
    const dz = el(`<section class="card danger-zone">${sectionTitle("Sauvegarde & suppression")}<div class="btn-row"></div></section>`);
    const exp = el('<button class="btn subtle" type="button">⬇︎ Exporter (JSON)</button>');
    exp.onclick = () => {
      const cur = Store.getTournament(tid);
      const blob = new Blob([JSON.stringify(cur, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = slug(cur.name) + "-" + (cur.date || "tournoi") + ".json";
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
    };
    const del = el('<button class="btn danger" type="button">Supprimer le tournoi</button>');
    del.onclick = () => ask({ title: "Supprimer ce tournoi ?", html: `<p>« <b>${esc(t.name)}</b> » sera supprimé définitivement, avec tous ses scores${isCloud() ? ", pour tout le monde" : ""}.</p>`, ok: "Supprimer", cancel: "Garder le tournoi", danger: true }).then((ok) => {
      if (!ok) return;
      settingsForm = null;
      Store.deleteTournament(tid);
      navigate("#/");
      toast("Tournoi supprimé.");
    });
    dz.querySelector(".btn-row").appendChild(exp);
    dz.querySelector(".btn-row").appendChild(del);
    $app.appendChild(dz);

    // « Toutes les corrections › » : on défile UNE fois, puis on oublie l'ancre
    // (les re-rendus suivants gardent la position de défilement).
    if (ui.scrollToCorr) {
      ui.scrollToCorr = false;
      const clean = "#/t/" + encodeURIComponent(tid) + "/settings";
      try { history.replaceState(history.state, "", clean); currentPath = parseHash(); } catch (e) { /* */ }
      const c = $("#corrections");
      if (c) setTimeout(() => c.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    }
  });
  // « #/t/:id/settings#corrections » → même vue, défilement vers les corrections
  route("/t/:id/settings#corrections", function (p) {
    ui.scrollToCorr = true;
    routes.find((r) => r.rx.test("/t/x/settings")).handler(p);
  });

  function correctionsCard(t, st) {
    const tid = t.id;
    const done = realMatches(st.all).filter((m) => m.status === "done").sort((a, b) => (b.at || 0) - (a.at || 0));
    const card = el(`<section class="card" id="corrections">${sectionTitle("Corrections", `<span class="count-badge">${nz(done.length)}</span>`)}
      <p class="muted small">Corriger ou effacer un score déjà saisi. Toutes les conséquences (repêchage, consolante, adversaires) sont détaillées avant validation.</p>
      ${done.length > 6 ? `<div class="search-bar inline"><input type="search" placeholder="Filtrer par joueur…" value="${esc(ui.corrQ)}" aria-label="Filtrer les matchs" /></div>` : ""}
      <div class="corr-list"></div></section>`);
    const list = card.querySelector(".corr-list");
    function draw() {
      clear(list);
      const q = norm(ui.corrQ.trim());
      let rows = done.filter((m) => !q || norm(pname(t, m.p1)).includes(q) || norm(pname(t, m.p2)).includes(q));
      if (!done.length) { list.appendChild(el('<div class="empty slim"><p>Aucun score saisi pour l’instant.</p></div>')); return; }
      const total = rows.length;
      if (!ui.corrAll && !q) rows = rows.slice(0, 12);
      rows.forEach((m) => {
        const w1 = m.winner === m.p1;
        const row = el(`<div class="corr-row">
          <div class="cr-main">
            <span class="cr-stage">${esc(stageLabel(st, m, true))} · ${esc(ago(m.at))}</span>
            <span class="cr-score"><b>${esc(pname(t, m.winner))}</b> <span class="sc">${nz(w1 ? m.score1 : m.score2)}–${nz(w1 ? m.score2 : m.score1)}</span> <span class="lo">${esc(pname(t, m.loser))}</span></span>
          </div>
          <div class="cr-actions"><button type="button" class="btn sm subtle fix">Corriger</button><button type="button" class="btn sm danger clr">Effacer</button></div>
        </div>`);
        row.querySelector(".fix").onclick = () => openScore(tid, m.id, { overwrite: true });
        row.querySelector(".clr").onclick = () => clearFlow(tid, m.id);
        list.appendChild(row);
      });
      if (rows.length < total) {
        const more = el(`<button type="button" class="btn ghost sm more">Afficher les ${nz(total)} matchs</button>`);
        more.onclick = () => { ui.corrAll = true; draw(); };
        list.appendChild(more);
      }
    }
    const inp = card.querySelector(".search-bar input");
    if (inp) inp.addEventListener("input", () => { ui.corrQ = inp.value; draw(); });
    draw();
    return card;
  }

  function clearFlow(tid, matchId) {
    const t = Store.getTournament(tid);
    if (!t) return;
    const st = Store.state(t);
    const m = st.byId[matchId];
    if (!m || m.status !== "done") return;
    const d = simulateChange(tid, matchId, null);
    const sum = needsConfirm(d) ? impactSummaryHtml(t, st, d, "L’effacement") : "";
    const html = `<p>Effacer le score <b>${esc(pname(t, m.p1))} ${nz(m.score1)} – ${nz(m.score2)} ${esc(pname(t, m.p2))}</b> (${esc(stageLabel(st, m, true))}) ? Le match repassera « à jouer ».</p>` +
      (sum || '<div class="impact ok">Aucun autre match n’est affecté.</div>');
    ask({ title: "Effacer un score", html, ok: "Effacer le score", cancel: "Garder le score", danger: true, cls: sum ? "wide" : "" }).then((ok) => {
      if (!ok) return;
      const t2 = Store.getTournament(tid);
      const d2 = simulateChange(tid, matchId, null);
      const r = Store.clearScore(tid, matchId);
      if (r.error) { toast(r.error, "err"); return; }
      refresh();
      if (t2 && needsConfirm(d2)) {
        const call = playersToCall(t2, d2, [m.p1, m.p2]);
        modal({
          title: "Score effacé", cls: "ask",
          body: [el(`<div class="call-banner"><div class="cb-title">📣 Joueurs à prévenir</div>${call.length ? `<div class="cb-list">${call.map((pid) => `<span class="chip">${esc(pname(t2, pid))}</span>`).join(" ")}</div>` : ""}<div class="cb-note">${esc(pname(t2, m.p1))} – ${esc(pname(t2, m.p2))} repasse « à jouer »${d2.phase1Reopened ? " · la phase 1 est rouverte" : ""}.</div></div>`)],
          actions: [{ label: "OK", onClick: (c) => c() }],
        });
      } else toast("Score effacé.");
    });
  }

  function cloudCard() {
    const status = cloudStatus();
    const cloud = isCloud();
    const pend = pendingOps();
    const txt = {
      local: ["📦", "Mode local (ce navigateur)", "Les données restent sur cet appareil. Dès que la base partagée est branchée sur Vercel, tout se synchronise automatiquement."],
      connected: ["☁︎", "Connecté — données partagées en direct", "Tous les écrans (table d’arbitrage, téléphones, affichage public) voient les mêmes scores en quelques secondes."],
      syncing: ["⟳", "Synchronisation en cours…", "Envoi des dernières modifications."],
      error: ["⚠︎", "Connexion perdue", "Les scores sont conservés sur cet appareil et seront renvoyés automatiquement dès le retour du réseau."],
    }[status] || ["☁︎", status, ""];
    const card = el(`<section class="card">${sectionTitle("Base de données partagée")}
      <div class="info-banner ${status === "connected" ? "ok" : status === "error" ? "wait" : ""}"><span class="ico">${txt[0]}</span><div class="ib-txt"><strong>${esc(txt[1])}</strong><br/><span class="muted">${esc(txt[2])}</span>${pend ? `<br/><b class="pend">${plural(pend, "opération", "opérations")} en attente d’envoi</b>` : ""}</div></div>
      <div class="btn-row"></div></section>`);
    const row = card.querySelector(".btn-row");
    const reload = el('<button class="btn subtle" type="button">⟳ Recharger depuis le cloud</button>');
    reload.disabled = !cloud || !cloudHas("pullNow");
    reload.onclick = () => {
      reload.disabled = true; reload.textContent = "Chargement…";
      Promise.resolve(cloudCall("pullNow")).then((r) => {
        if (r && r.error) toast(r.error, "err"); else toast("Données rechargées.");
      }).catch((e) => toast(String(e && e.message || e), "err")).then(() => { updateSyncPill(); refresh(); });
    };
    row.appendChild(reload);
    if (cloud && cloudHas("pushPending")) {
      const push = el('<button class="btn subtle" type="button">⬆︎ Forcer l’envoi</button>');
      push.onclick = () => {
        push.disabled = true; push.textContent = "Envoi…";
        Promise.resolve(cloudCall("pushPending", "envoi manuel")).then((r) => {
          if (r && r.error) toast(r.error, "err"); else toast("Données envoyées ✓");
        }).catch((e) => toast(String(e && e.message || e), "err")).then(() => { updateSyncPill(); refresh(); });
      };
      row.appendChild(push);
    }
    return card;
  }

  // ============================================================
  //  VUE : Arbre plein écran (moteur de mise en page JS)
  // ============================================================
  // Unités « arbre » (avant mise à l'échelle). FS = taille des noms.
  const TR = { CW: 182, CH: 54, GX: 22, GY: 10, CH0C: 30, GY0C: 6, HEAD: 44, PAD: 14, BW: 300, BH: 82, BH2: 118, BGAP: 24, FS: 17, SMAX: 1.6 };
  const FONT_STACK = "Jost, system-ui, -apple-system, 'Segoe UI', sans-serif";
  const tv = { tid: null, view: "main", flash: null };

  /** Dimensions des cartes : D.CW0/D.CH0 = colonne des feuilles (cartes compactes d'une ligne). */
  function treeDims(CW, compact, headFs) {
    headFs = headFs || 13;
    // compact : "done" (« Vainqueur 7–3 Perdant ») ou "pending" (« A – B », deux noms à loger).
    return {
      CW, CH: TR.CH, GX: TR.GX, GY: TR.GY, PAD: TR.PAD, FS: TR.FS,
      CW0: compact ? Math.round(CW * (compact === "pending" ? 1.5 : 1.32)) : CW,
      CH0: compact ? TR.CH0C : TR.CH,
      GY0: compact ? TR.GY0C : TR.GY,
      compact, headFs, HEAD: Math.round(headFs * 2.75 + 10),
    };
  }

  /** Colonnes de l'arbre → positions (miroir en paysage, gauche→droite sinon). */
  function layoutTree(levels, mirrored, D) {
    const L = levels.length;
    const mir = mirrored && L >= 2;
    const step = D.CW + D.GX, row0 = D.CH0 + D.GY0;
    const xC = D.CW0 + D.GX + (L - 2) * step;
    const colX = (l, side) => {
      if (!mir) return l === 0 ? 0 : D.CW0 + D.GX + (l - 1) * step;
      if (side === "C") return xC;
      if (side === "L") return l === 0 ? 0 : D.CW0 + D.GX + (l - 1) * step;
      return l === 0 ? xC + (L - 1) * step : xC + (L - 1 - l) * step;
    };
    const pos = levels.map((lv) => new Array(lv.length));
    const half0 = levels[0].length / 2;
    for (let l = 0; l < L; l++) {
      const n = levels[l].length;
      const w = l === 0 ? D.CW0 : D.CW, h = l === 0 ? D.CH0 : D.CH;
      for (let i = 0; i < n; i++) {
        let side = "L";
        if (mir) side = l === L - 1 ? "C" : (i < n / 2 ? "L" : "R");
        let cy;
        if (l === 0) cy = (mir ? (i < half0 ? i : i - half0) : i) * row0 + h / 2;
        else {
          const a = pos[l - 1][2 * i], b = pos[l - 1][2 * i + 1];
          cy = b ? (a.cy + b.cy) / 2 : a.cy;
        }
        pos[l][i] = { x: colX(l, side), y: cy - h / 2, cy, w, h, side };
      }
    }
    return { pos, mir, L };
  }

  /** Cadre complet (cartes + bannière + en-têtes) → largeur/hauteur de l'arbre. */
  function treeFrame(lay, D, BW, BH) {
    const { pos, mir, L } = lay;
    const f = pos[L - 1][0];
    const bx = (mir || L === 1) ? f.x + f.w / 2 - BW / 2 : f.x;
    const by = f.y - TR.BGAP - BH;
    let minX = Math.min(0, bx), maxX = bx + BW, minY = Math.min(0, by), maxY = 0;
    pos.forEach((lv) => lv.forEach((p) => { maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.h); minY = Math.min(minY, p.y); }));
    const headY = minY - D.HEAD - 12;          // 12 : place pour l'étiquette « À jouer » des cartes du haut
    const ox = D.PAD - minX, oy = D.PAD - headY;
    return { bx, by, ox, oy, headY, W: Math.ceil(maxX - minX + 2 * D.PAD), H: Math.ceil(maxY - headY + 2 * D.PAD) };
  }

  /** Largeur souhaitée de la bannière du champion (mesurée, plus d'estimation au caractère). */
  function bannerNeed(name, title) {
    const nameW = textWidth("🏆 " + name, "600 28px 'Cormorant Garamond', Georgia, serif");
    const eyeW = textWidth(String(title).toUpperCase(), "500 11px " + FONT_STACK) + title.length * 2;
    return Math.ceil(Math.max(TR.BW, 56 + 14 + 36 + 12 + Math.max(nameW, eyeW)));
  }
  /** Bannière la plus large possible sans chevaucher de carte ; 2 lignes si le nom est trop long. */
  function bannerFit(lay, need) {
    const { pos, mir, L } = lay;
    const f = pos[L - 1][0];
    if (!(mir || L === 1)) return { BW: Math.min(need, 680), BH: TR.BH, wrap: false };
    const hits = (BW, BH) => {
      const bx = f.x + f.w / 2 - BW / 2, by = f.y - TR.BGAP - BH;
      for (const lv of pos) for (const p of lv) {
        if (p === f) continue;
        if (p.x < bx + BW + 8 && p.x + p.w > bx - 8 && p.y < by + BH + 8 && p.y + p.h > by - 8) return true;
      }
      return false;
    };
    let BW = Math.min(need, 900);
    while (BW > TR.BW && hits(BW, TR.BH)) BW -= 20;
    BW = Math.max(TR.BW, BW);
    if (need <= BW + 2) return { BW, BH: TR.BH, wrap: false };
    if (!hits(BW, TR.BH2)) return { BW, BH: TR.BH2, wrap: true };
    return { BW, BH: TR.BH, wrap: false };
  }

  /**
   * Choix de la largeur des cartes pour l'écran disponible : on maximise la taille
   * réelle des noms ; quand c'est la hauteur qui limite, on élargit les cartes
   * (moins de noms tronqués) sans rien perdre en taille.
   */
  function chooseDims(levels, mirrored, compact, aw, ah, need) {
    const evalCW = (CW, headFs) => {
      const D = treeDims(CW, compact, headFs);
      const lay = layoutTree(levels, mirrored, D);
      const fr = treeFrame(lay, D, Math.min(need, 640), TR.BH);
      return { D, s: Math.min(aw / fr.W, ah / fr.H, TR.SMAX) };
    };
    const COMF = 20; // au-delà, des noms plus gros n'apportent rien : on préfère des cartes plus larges
    const cands = [];
    for (let CW = 164; CW <= 340; CW += 6) cands.push(evalCW(CW));
    const fOf = (c) => Math.min(c.s * TR.FS, COMF);
    const best = Math.max.apply(null, cands.map(fOf));
    // On accepte de perdre ~4 % de taille (jamais sous 13 px) pour des cartes plus larges.
    const floor = Math.max(best * 0.96, Math.min(best, 13));
    let pick = null;
    cands.forEach((c) => { if (fOf(c) >= floor - 1e-6 && (!pick || c.D.CW > pick.D.CW)) pick = c; });
    if (!pick) pick = cands.reduce((a, c) => (fOf(c) > fOf(a) ? c : a), cands[0]);
    // En-têtes de colonnes lisibles à l'écran : taille visée en px réels, convertie en unités d'arbre.
    const want = Math.max(12, Math.min(18, (window.innerWidth || 1280) * 0.0078));
    const headFs = Math.max(12, Math.min(30, want / Math.max(0.2, pick.s)));
    return evalCW(pick.D.CW, headFs).D;
  }

  /** Libellé d'un siège encore inconnu. */
  function tbdLabel(t, st, src, arrow) {
    if (!src) return "—";
    if (src.type === "rep") return "Repêché n°" + nz(src.k);
    if (src.type === "exempt") return pname(t, src.pid);
    if (src.type === "p1" || src.type === "winner") {
      const sm = st.byId[src.matchId];
      // Noms de famille : les deux joueurs restent identifiables sur une carte étroite.
      if (sm && sm.p1 && sm.p2 && sm.p1 !== "BYE" && sm.p2 !== "BYE") return "Vainq. " + lastName(pname(t, sm.p1)) + " / " + lastName(pname(t, sm.p2));
      return "Vainqueur " + arrow;
    }
    return "—";
  }
  /** Version complète (infobulle) du libellé d'un siège inconnu. */
  function tbdTitle(t, st, src) {
    if (src && (src.type === "p1" || src.type === "winner")) {
      const sm = st.byId[src.matchId];
      if (sm && sm.p1 && sm.p2 && sm.p1 !== "BYE" && sm.p2 !== "BYE") return "Vainqueur de " + pname(t, sm.p1) + " – " + pname(t, sm.p2);
    }
    return "";
  }

  /** Ligne de carte : name/sc sont du HTML déjà échappé. */
  function trow(cls, name, sc, title) {
    return `<div class="r ${cls}"${title ? ` title="${esc(title)}"` : ""}><span class="n">${name}</span><span class="s">${sc == null ? "" : sc}</span></div>`;
  }

  function treeCard(t, st, node, info) {
    const D = info.D;
    const fName = (w) => `${w} ${D.FS}px ${FONT_STACK}`;
    const nameW = D.CW - 49;                      // largeur utile d'un nom (carte à 2 lignes)
    const fit = (pid, w, weight) => esc(fitName(pname(t, pid), w, fName(weight || 600)));
    const compact = info.compact;
    if (node.kind === "exempt") {
      const nm = pname(t, node.pid);
      if (compact) return { cls: "leaf exempt c1", html: `<div class="r one in" title="${esc(nm)} · exempt"><span class="n">${fit(node.pid, D.CW0 - 90)}</span><span class="note">exempt</span></div>` };
      return { cls: "leaf exempt", html: trow("in", fit(node.pid, nameW), "", nm) + trow("note", "Exempt · qualifié d’office", "") };
    }
    if (node.kind === "rep") {
      const k = nz(node.k);
      if (node.pid) {
        const r = st.repechage.ranking.find((x) => x.pid === node.pid);
        const nm = pname(t, node.pid);
        const pts = r ? " · " + plural(r.pf, "pt") : "";
        if (compact) return { cls: "leaf rep known c1", html: `<div class="r one in" title="${esc(nm)} · repêché n°${k}${esc(pts)}"><span class="n">${fit(node.pid, D.CW0 - 104)}</span><span class="note">repêché${esc(pts)}</span></div>` };
        return { cls: "leaf rep known", html: trow("in", fit(node.pid, nameW), "", nm) + trow("note", "Repêché n°" + k + esc(pts), "") };
      }
      if (compact) return { cls: "leaf rep c1", html: `<div class="r one tbd"><span class="n">Repêché n°${k}</span><span class="note">meilleur perdant</span></div>` };
      return { cls: "leaf rep", html: trow("tbd", "Repêché n°" + k, "") + trow("note", "Meilleur perdant", "") };
    }
    const m = node.match;
    if (m.bye) {
      const who = m.p1 === "BYE" ? m.p2 : m.p1;
      const nm = pname(t, who);
      return { cls: "bye", html: `<div class="r one in" title="${esc(nm)} · exempt"><span class="n">${fit(who, D.CW - 76)}</span><span class="note">exempt</span></div>` };
    }
    let cls = "match " + (m.status === "done" || m.status === "ready" ? m.status : "pending");
    if (info.final) cls += " final";
    if (info.fresh) cls += " flash";
    const ready = m.status === "ready";
    const extra = ready ? (info.level > 0 ? '<span class="tag">À jouer</span>' : "") + '<span class="pulse" aria-hidden="true"></span>' : "";
    if (compact) {
      // Feuille de phase 1 sur une ligne : « Vainqueur 7–3 Perdant » ou « A – B ».
      cls += " c1";
      const avail = D.CW0 - 19 - 12;
      if (m.status === "done") {
        const w1 = m.winner === m.p1;
        const sc = `${nz(w1 ? m.score1 : m.score2)}–${nz(w1 ? m.score2 : m.score1)}`;
        const left = avail - textWidth(sc, fName(600));
        const title = `${pname(t, m.winner)} ${sc} ${pname(t, m.loser)}`;
        // Le vainqueur d'abord (jusqu'à 70 % de la place), le perdant prend le reste.
        const wTxt = fitName(pname(t, m.winner), left * 0.7, fName(600));
        const wUsed = Math.min(textWidth(wTxt, fName(600)), left * 0.7);
        const lW = left - wUsed;
        // Perdant : nom complet, sinon initiale + nom, sinon nom seul — et s'il ne tient
        // vraiment pas, on l'omet (il reste dans l'infobulle) plutôt que « M. … ».
        const lName = pname(t, m.loser);
        const lFit = [lName, initialsName(lName), lastName(lName)].filter(Boolean).find((c) => textWidth(c, fName(400)) <= lW);
        const loser = lFit ? `<span class="n l">${esc(lFit)}</span>` : "";
        return { cls, html: `<div class="r one" title="${esc(title)}"><span class="n w">${esc(wTxt)}</span><span class="sc">${sc}</span>${loser}</div>${extra}` };
      }
      const half = (avail - 14 - (ready ? 14 : 0)) / 2;
      const title = `${pname(t, m.p1)} – ${pname(t, m.p2)}`;
      return { cls, html: `<div class="r one" title="${esc(title)}"><span class="n a">${fit(m.p1, half, 500)}</span><span class="dash">–</span><span class="n b">${fit(m.p2, half, 500)}</span></div>${extra}` };
    }
    const seat = (slot) => {
      const pid = m["p" + slot];
      if (pid === "BYE") return trow("tbd", "Exempt", "");
      if (!pid) return trow("tbd", esc(tbdLabel(t, st, m["src" + slot], info.arrows[slot - 1])), "", tbdTitle(t, st, m["src" + slot]));
      const c = m.status === "done" ? (m.winner === pid ? "win" : "lose") : "";
      return trow(c, fit(pid, nameW), m.status === "done" ? nz(m["score" + slot]) : "", pname(t, pid));
    };
    return { cls, html: seat(1) + seat(2) + extra };
  }

  function treeHtml(t, st, levels, cons, mirrored, isFresh, D) {
    const lay = layoutTree(levels, mirrored, D);
    const pos = lay.pos, L = lay.L, mir = lay.mir;
    const f = pos[L - 1][0];
    const champ = cons ? st.consolante.champion : st.champion;
    const bTitle = cons ? "Vainqueur de la consolante" : "Champion";
    const champName = champ ? pname(t, champ) : "À venir";
    const bf = bannerFit(lay, bannerNeed(champName, bTitle));
    const BW = bf.BW, BH = bf.BH;
    const fr = treeFrame(lay, D, BW, BH);
    const { ox, oy, W, H } = fr;

    // En-têtes de colonnes
    const K = cons ? st.consolante.totalRounds : st.main.totalRounds;
    const label = (l) => {
      if (cons) return [shortRound(K, l + 1), levels[l][0].match.points];
      if (l === 0) {
        const lm = levels[0].find((n) => n.kind === "match");
        if (st.main.size === 1) return ["Finale", lm ? lm.match.points : t.settings.mainPoints[0]];
        return ["Phase 1", lm ? lm.match.points : t.settings.pointsPhase1];
      }
      return [shortRound(K, l), levels[l][0].match.points];
    };
    let heads = "";
    const head = (p, l) => {
      const lb = label(l);
      return `<div class="col-head${l === L - 1 ? " fin" : ""}" style="left:${Math.round(p.x + ox)}px;top:${Math.round(fr.headY + oy)}px;width:${Math.round(p.w)}px;height:${D.HEAD - 6}px"><b>${esc(lb[0])}</b><span>${plural(lb[1], "pt")}</span></div>`;
    };
    for (let l = 0; l < L; l++) {
      heads += head(pos[l][0], l);
      if (mir && l !== L - 1) heads += head(pos[l][levels[l].length - 1], l);
    }

    // Connecteurs (coudes)
    const winnerOf = (n) => (n.kind === "match" ? (n.match.status === "done" ? n.match.winner : null) : n.pid);
    let grey = "", gold = "", champPath = "";
    for (let l = 1; l < L; l++) {
      levels[l].forEach((node, i) => {
        const p = pos[l][i], pm = node.match;
        for (let k = 0; k < 2; k++) {
          const c = pos[l - 1][2 * i + k];
          if (!c) continue;
          const cy = Math.round(c.cy + oy), py = Math.round(p.cy + oy);
          const sx = Math.round((c.side === "R" ? c.x : c.x + c.w) + ox);
          const tx = Math.round((c.side === "R" ? p.x + p.w : p.x) + ox);
          const mx = Math.round((sx + tx) / 2);
          const d = `M${sx} ${cy}H${mx}V${py}H${tx}`;
          const cn = levels[l - 1][2 * i + k];
          // pathLength=1 : l'animation « dessin » couvre toute la longueur, quelle qu'elle soit.
          const fresh = cn.kind === "match" && isFresh(cn.match) ? ' class="fresh" pathLength="1"' : "";
          if (pm && pm["p" + (k + 1)]) {
            if (champ && winnerOf(cn) === champ) champPath += `<path${fresh} d="${d}"/>`;
            else gold += `<path${fresh} d="${d}"/>`;
          } else grey += `<path d="${d}"/>`;
        }
      });
    }
    const svg = `<svg class="tree-lines" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><g class="ln">${grey}</g><g class="ln gold">${gold}</g><g class="ln gold champ">${champPath}</g></svg>`;

    // Cartes
    let cards = "";
    for (let l = 0; l < L; l++) {
      levels[l].forEach((node, i) => {
        const p = pos[l][i];
        const arrows = [0, 1].map((k) => {
          if (l === 0) return "";
          const c = pos[l - 1][2 * i + k];
          if (mir && p.side === "C") return c.side === "R" ? "→" : "←";
          return c.cy < p.cy ? "↑" : "↓";
        });
        const c = treeCard(t, st, node, { D, level: l, compact: l === 0 && D.compact, final: l === L - 1, arrows, fresh: node.kind === "match" && isFresh(node.match) });
        cards += `<div class="tc ${c.cls}${l === 0 ? " l0" : ""}" style="left:${Math.round(p.x + ox)}px;top:${Math.round(p.y + oy)}px"${node.match ? ` data-id="${esc(node.match.id)}"` : ""}>${c.html}</div>`;
      });
    }

    // Bannière champion
    const finM = levels[L - 1][0].match;
    const bStyle = `left:${Math.round(fr.bx + ox)}px;top:${Math.round(fr.by + oy)}px;width:${BW}px;height:${BH}px`;
    const wrapCls = bf.wrap ? " wrap" : "";
    const banner = champ
      ? `<div class="t-banner won${wrapCls}${finM && isFresh(finM) ? " fresh" : ""}" style="${bStyle}" title="${esc(champName)}"><img src="${LOGO}" alt="" class="crest" /><div class="tb-txt"><div class="tb-eyebrow">${bTitle}</div><div class="tb-name">🏆 ${esc(champName)}</div></div></div>`
      : `<div class="t-banner" style="${bStyle}"><span class="tb-cup">🏆</span><div class="tb-txt"><div class="tb-eyebrow">${bTitle}</div><div class="tb-name">À venir</div></div></div>`;

    const vars = `--cw:${D.CW}px;--ch:${D.CH}px;--cw0:${D.CW0}px;--ch0:${D.CH0}px;--fs:${D.FS}px;--hfs:${D.headFs.toFixed(1)}px`;
    return `<div class="tree ${cons ? "is-cons" : "is-main"} ${mir ? "mirrored" : "ltr"}${D.compact ? " compact" : ""}" style="width:${W}px;height:${H}px;${vars}">${svg}${heads}${cards}${banner}</div>`;
  }

  function mainTreeStatus(t, st) {
    if (st.champion) return { cls: "ok", label: "Terminé · 🏆 " + pname(t, st.champion) };
    if (st.main.size <= 1) return { cls: "gold live", label: "Finale · à jouer" };
    if (!st.phase1.done) return { cls: "gold live", label: "Phase 1 · " + st.phase1.played + "/" + st.phase1.total };
    const mm = realMatches([].concat.apply([], st.main.rounds));
    const r = firstOpenRound(st.main.rounds);
    return { cls: "gold live", label: "Tableau final · " + (r ? shortRound(st.main.totalRounds, r) + " · " : "") + countDone(mm) + "/" + mm.length };
  }
  function consTreeStatus(t, st) {
    const c = st.consolante;
    if (!c) return { cls: "neutral", label: "Après la phase 1" };
    if (c.champion) return { cls: "ok", label: "Terminée · 🏆 " + pname(t, c.champion) };
    const cm = realMatches([].concat.apply([], c.rounds));
    const r = firstOpenRound(c.rounds);
    return { cls: "gold live", label: (r ? shortRound(c.totalRounds, r) + " · " : "") + countDone(cm) + "/" + cm.length };
  }

  route("/t/:id/bracket", function (p) {
    const t0 = Store.getTournament(p.id);
    if (!t0) { document.body.classList.remove("fullbleed"); return notFound(); }
    const tid = t0.id;
    if (tv.tid !== tid) { tv.view = "main"; tv.flash = null; }
    tv.tid = tid;
    const S = {
      rotateOn: t0.settings.autoRotate !== false, autoSetting: t0.settings.autoRotate !== false,
      fit: pref("treeFit", true), seen: new Map(), inited: false, drawId: null,
      lastView: null, portrait: null, hinted: false, timer: null, box: null, D: null,
    };
    const coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);

    const root = el(`<div class="tree-view">
      <div class="tree-stage"><div class="tree-fit"></div></div>
      <header class="tree-top">
        <button class="tree-back" type="button" aria-label="Retour" title="Retour">‹</button>
        <div class="tree-title"><div class="tt-eyebrow"></div><div class="tt-row"><h1 class="tt-name">Tableau</h1><span class="pill tt-status"></span></div></div>
        <div class="tree-clock"><span class="live-dot" title="En direct"></span><span class="clk"></span></div>
      </header>
      <nav class="tree-dock" aria-label="Affichage">
        <button type="button" data-v="main">Principal</button>
        <button type="button" data-v="cons">Consolante</button>
        <span class="dock-sep"></span>
        <button type="button" class="ico rot" title="Rotation automatique" aria-label="Rotation automatique">⟳</button>
        <button type="button" class="ico fitbtn" title="Ajuster à l’écran / 100 %" aria-label="Zoom">⤢</button>
      </nav>
      <div class="rot-bar" hidden></div>
      <div class="tree-hint" hidden>Touchez ⤢ pour afficher à 100 %</div>
    </div>`);
    $app.appendChild(root);
    const stage = $(".tree-stage", root), fitEl = $(".tree-fit", root), dock = $(".tree-dock", root), bar = $(".rot-bar", root);

    $(".tree-back", root).onclick = () => { if (navCount > 0) history.back(); else navigate("#/t/" + encodeURIComponent(tid) + "/players"); };
    dock.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || b.disabled) return;
      if (b.dataset.v) { tv.view = b.dataset.v === "cons" ? "cons" : "main"; stopCycle(); update(); }
      else if (b.classList.contains("rot")) { S.rotateOn = !S.rotateOn; stopCycle(); update(); toast(S.rotateOn ? "Rotation automatique activée" : "Rotation automatique en pause"); }
      else if (b.classList.contains("fitbtn")) { S.fit = !S.fit; setPref("treeFit", S.fit); update(); }
    });

    function stopCycle() { clearTimeout(S.timer); S.timer = null; }
    function startCycle(secs) {
      stopCycle();
      bar.hidden = false;
      bar.innerHTML = `<i style="animation-duration:${nz(secs)}s"></i>`;
      S.timer = setTimeout(() => { S.timer = null; tv.view = tv.view === "main" ? "cons" : "main"; update(); }, secs * 1000);
    }
    function isPortrait() { return window.innerHeight > window.innerWidth; }
    function isFresh(m) {
      if (!m || m.status !== "done") return false;
      const at = S.seen.get(m.id);
      return !!at && Date.now() - at < 9000;
    }

    function showEmpty(t) {
      root.classList.add("is-empty");
      stopCycle(); bar.hidden = true;
      $(".tt-name", root).textContent = "Tableau";
      const pill = $(".tt-status", root);
      pill.className = "pill tt-status slate"; pill.innerHTML = "<i></i>Inscriptions";
      stage.classList.remove("scroll");
      fitEl.removeAttribute("style");
      fitEl.innerHTML = `<div class="tree-empty"><img src="${LOGO}" alt="" class="crest" /><h2>Tirage pas encore effectué</h2><p>${plural(t.players.length, "joueur inscrit", "joueurs inscrits")}. L’arbre apparaîtra ici dès le tirage au sort.</p><a class="btn" href="#/t/${encodeURIComponent(t.id)}/players">Aller aux inscriptions</a></div>`;
    }

    function chromeDock(t, st) {
      t = t || Store.getTournament(tid);
      if (!t) return;
      st = st || Store.state(t);
      const cons = tv.view === "cons";
      const bm = $('[data-v="main"]', dock), bc = $('[data-v="cons"]', dock), rot = $(".rot", dock), fb = $(".fitbtn", dock);
      const consPossible = !!st.consolante || (t.settings.consolante !== false && st.plan.ok && st.plan.consolante >= 2);
      bc.hidden = !consPossible; rot.hidden = !consPossible; $(".dock-sep", dock).hidden = !consPossible;
      bc.disabled = !st.consolante;
      bc.title = st.consolante ? "Afficher la consolante" : "Disponible à la fin de la phase 1";
      bm.classList.toggle("active", !cons);
      bc.classList.toggle("active", cons);
      rot.classList.toggle("on", S.rotateOn && !!st.consolante);
      rot.disabled = !st.consolante;
      rot.title = S.rotateOn ? "Rotation automatique : activée (toucher pour mettre en pause)" : "Rotation automatique : en pause";
      fb.classList.toggle("on", !S.fit);
      fb.title = S.fit ? "Afficher à 100 % (défilement)" : "Ajuster à l’écran";
    }

    /** Zone disponible entre le bandeau du haut et le dock. */
    function availBox() {
      const top = $(".tree-top", root).getBoundingClientRect().bottom + 4;
      const dr = dock.getBoundingClientRect();
      const bottom = (dr.height ? dr.top : window.innerHeight) - 10;
      const vw = stage.clientWidth || window.innerWidth, vh = stage.clientHeight || window.innerHeight;
      return { top, bottom, vw, vh, aw: Math.max(60, vw - 24), ah: Math.max(60, bottom - top) };
    }

    function applyFit() {
      const tree = fitEl.firstElementChild;
      if (!tree || root.classList.contains("is-empty") || !tree.classList.contains("tree")) return;
      const W = parseFloat(tree.style.width), H = parseFloat(tree.style.height);
      const box = availBox();
      if (!box.vw || !box.vh || !W || !H) return;
      root.classList.toggle("zoom100", !S.fit);
      if (S.fit) {
        stage.classList.remove("scroll");
        let s = Math.min(box.aw / W, box.ah / H);
        s = Math.max(0.08, Math.min(TR.SMAX, s));
        fitEl.style.cssText = `left:50%;top:${Math.round(box.top + box.ah / 2)}px;transform:translate(-50%,-50%) scale(${s.toFixed(4)})`;
        root.dataset.scale = s.toFixed(3);
        const hint = $(".tree-hint", root);
        // Indice tactile uniquement sur écran tactile (jamais sur la TV).
        if (coarse && s < 0.45 && !S.hinted) {
          S.hinted = true; hint.hidden = false;
          setTimeout(() => { hint.hidden = true; }, 4500);
        }
      } else {
        stage.classList.add("scroll");
        $(".tree-hint", root).hidden = true;
        fitEl.style.cssText = `padding:${Math.round(box.top)}px 16px ${Math.round(box.vh - box.bottom + 10)}px`;
        root.dataset.scale = "1";
      }
    }

    function update() {
      const t = Store.getTournament(tid);
      if (!t) { live = null; render(); return; }
      const st = Store.state(t);
      $(".tt-eyebrow", root).textContent = t.name;
      tick();
      if (!st.drawn) { showEmpty(t); chromeDock(t, st); return; }
      root.classList.remove("is-empty");
      if (S.drawId !== t.draw.id) { S.seen = new Map(); S.inited = false; S.drawId = t.draw.id; }
      const now = Date.now();
      // Match qui vient d'être saisi depuis le pop-up « Voir l'arbre » : il flashe à l'arrivée.
      const fl = tv.flash && now - tv.flash.at < 20000 ? tv.flash.id : null;
      st.all.forEach((m) => { if (m.status === "done" && !m.bye && !S.seen.has(m.id)) S.seen.set(m.id, S.inited || m.id === fl ? now : 0); });
      S.seen.forEach((v, id) => { const m = st.byId[id]; if (!m || m.status !== "done") S.seen.delete(id); });
      S.inited = true;
      tv.flash = null;
      const auto = t.settings.autoRotate !== false;
      if (auto !== S.autoSetting) { S.autoSetting = auto; S.rotateOn = auto; stopCycle(); }
      if (tv.view === "cons" && !st.consolante) tv.view = "main";

      // Habillage (avant l'arbre : sa hauteur compte dans la place disponible)
      const cons = tv.view === "cons";
      $(".tt-name", root).textContent = cons ? "Consolante" : "Tableau principal";
      const s = cons ? consTreeStatus(t, st) : mainTreeStatus(t, st);
      const pill = $(".tt-status", root);
      pill.className = "pill tt-status " + s.cls;
      pill.innerHTML = "<i></i>" + esc(s.label);
      chromeDock(t, st);

      // Arbre : feuilles de phase 1 compactes (1 ligne) dès que la phase 1 est finie
      // ou que le tableau est grand → l'arbre est deux fois moins haut.
      S.portrait = isPortrait();
      const asNodes = (r) => r.map((m) => ({ kind: "match", match: m }));
      const levels = cons ? st.consolante.rounds.map(asNodes) : [st.leaves].concat(st.main.rounds.map(asNodes));
      const compact = !cons && levels.length >= 2 && (st.phase1.done || st.main.size >= 64) ? (st.phase1.done ? "done" : "pending") : false;
      const box = availBox();
      S.box = box;
      const champ = cons ? st.consolante.champion : st.champion;
      const need = bannerNeed(champ ? pname(t, champ) : "À venir", cons ? "Vainqueur de la consolante" : "Champion");
      const D = S.fit ? chooseDims(levels, !S.portrait, compact, box.aw, box.ah, need) : treeDims(TR.CW, compact, 13);
      S.D = D;
      const node = el(treeHtml(t, st, levels, cons, !S.portrait, isFresh, D));
      if (S.lastView !== tv.view) node.classList.add("enter");
      S.lastView = tv.view;
      clear(fitEl);
      fitEl.appendChild(node);
      applyFit();

      // Rotation
      if (!(S.rotateOn && st.consolante)) { stopCycle(); bar.hidden = true; bar.innerHTML = ""; }
      else if (!S.timer) startCycle(Math.max(5, parseInt(t.settings.rotateSeconds, 10) || 20));
    }

    function tick() {
      $(".clk", root).textContent = fmtTime(Date.now());
      $(".live-dot", root).classList.toggle("on", isCloud() && cloudStatus() === "connected");
    }

    // Redimensionnement : nouvelle mise en page si la place disponible a changé.
    let relayoutTimer = null;
    const relayout = () => {
      clearTimeout(relayoutTimer);
      relayoutTimer = setTimeout(() => {
        if (live !== update) return;
        const b = availBox(), o = S.box;
        if (isPortrait() !== S.portrait || !o || Math.abs(b.aw - o.aw) > 2 || Math.abs(b.ah - o.ah) > 2) update(); else applyFit();
      }, 120);
    };
    window.addEventListener("resize", relayout);
    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(relayout); ro.observe(stage); }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { measureCache.clear(); if (live === update) update(); });
    const clockTimer = setInterval(tick, 10000);
    viewCleanup = () => {
      stopCycle();
      clearTimeout(relayoutTimer);
      clearInterval(clockTimer);
      window.removeEventListener("resize", relayout);
      if (ro) ro.disconnect();
    };
    update();
    live = update;
  });

  // ============================================================
  //  Pastille de synchronisation (barre du haut)
  // ============================================================
  function updateSyncPill() {
    const pill = document.getElementById("sync-pill");
    const label = document.getElementById("sync-label");
    if (!pill || !label) return;
    const st = cloudStatus();
    const pend = pendingOps();
    pill.classList.remove("connected", "error", "syncing", "pending");
    let txt = "Local";
    if (st === "connected") { pill.classList.add("connected"); txt = pend ? pend + " en attente" : "En ligne"; if (pend) pill.classList.add("pending"); }
    else if (st === "syncing") { pill.classList.add("syncing"); txt = "Synchro…"; }
    else if (st === "error") { pill.classList.add("error"); txt = pend ? "Hors ligne · " + pend + " en attente" : "Hors ligne"; }
    label.textContent = txt;
    pill.title = st === "local" ? "Mode local (ce navigateur)" : "Base de données partagée : " + txt;
  }

  // ============================================================
  //  Alerte persistante : le navigateur refuse d'enregistrer
  // ============================================================
  let cloudStorageFull = false;
  function syncStorageWarning() {
    let err = null;
    try { err = typeof Store.getStorageError === "function" ? Store.getStorageError() : null; } catch (e) { err = null; }
    let node = document.getElementById("storage-warn");
    const show = !!err || cloudStorageFull;
    if (!show) { if (node) node.remove(); return; }
    if (!node) {
      node = el('<div id="storage-warn" class="storage-warn" role="alert"></div>');
      document.body.insertBefore(node, $app);
    }
    node.innerHTML = `<span class="ico">⚠︎</span><span><b>Stockage de l’appareil plein</b> — les données ne sont plus sauvegardées sur cet appareil${isCloud() ? " (les scores déjà reçus par le cloud sont en sécurité)" : ""}. Libérez de l’espace ou utilisez un autre appareil.</span>`;
  }

  /** Messages du cloud (conflit de saisie, tirage refait ailleurs, tournoi supprimé…). */
  function onCloudNotice(n) {
    if (!n || typeof n !== "object") return;
    const msg = String(n.message || "");
    if (n.kind === "storage") { cloudStorageFull = true; syncStorageWarning(); if (msg) toast(msg, "err", null, { ms: 7000 }); return; }
    if (!msg) return;
    const kind = n.kind === "conflict" ? "err" : n.kind === "info" ? "" : "warn";
    toast(msg, kind, null, { ms: n.kind === "info" ? 3500 : 8000 });
  }

  // ============================================================
  //  Démarrage
  // ============================================================
  function boot() {
    try { Store.load(); } catch (e) { console.error(e); }
    cloudCall("onStatus", () => updateSyncPill());
    updateSyncPill();
    setInterval(updateSyncPill, 2500);

    const pill = document.getElementById("sync-pill");
    if (pill) pill.onclick = () => {
      const tid = tidOf(parseHash());
      if (tid) navigate("#/t/" + encodeURIComponent(tid) + "/settings");
      else toast(isCloud() ? "Données partagées en direct ☁︎" : "Mode local — voir Réglages d’un tournoi pour le partage.");
    };

    // Stockage local refusé (mémoire pleine, navigation privée…) : alerte persistante.
    if (typeof Store.onStorageError === "function") Store.onStorageError(() => syncStorageWarning());
    if (cloudHas("onNotice")) cloudCall("onNotice", onCloudNotice);

    // Toute mutation (locale ou distante) : titre + arbre en direct.
    Store.onChange(() => {
      renderNav();
      if (live) scheduleLive();
      if (document.getElementById("storage-warn") && !(typeof Store.getStorageError === "function" && Store.getStorageError())) { cloudStorageFull = false; syncStorageWarning(); }
    });
    window.addEventListener("hashchange", () => {
      navCount++;
      // Navigation pendant qu'une modale est ouverte : on la ferme (sans toucher à l'historique).
      if (anyModalOpen() && parseHash() !== currentPath) closeAllModals("nav");
      render();
    });

    // Changement venant du cloud : re-rendu sauf pendant une saisie.
    cloudCall("onRemoteChange", () => { firstSyncDone = true; externalChange(); updateSyncPill(); });

    // Mode local : synchronise les onglets d'un même navigateur (affichage public + saisie).
    window.addEventListener("storage", (e) => {
      if (e.key !== DB_KEY || isCloud()) return;
      try { Store.load(); } catch (err) { console.error(err); return; }
      externalChange();
    });

    // Un rafraîchissement a été différé (saisie en cours) : on l'applique dès que possible.
    setInterval(() => { if (pendingRefresh && !isBusy()) render({ keepScroll: true }); }, 900);

    // Le premier rendu ne doit JAMAIS empêcher la connexion au cloud.
    try { render(); } catch (e) {
      console.error(e);
      try { clear($app); $app.appendChild(el('<div class="empty"><div class="ico">🧭</div><h2>Page introuvable</h2><a class="btn" href="#/">Retour à l’accueil</a></div>')); } catch (x) { /* */ }
    }
    try { syncStorageWarning(); } catch (e) { /* */ }

    // Coquille hors-ligne : recharger la page sans réseau garde l'application.
    try {
      if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
    } catch (e) { /* navigateur sans service worker */ }

    Promise.resolve().then(() => cloudCall("init")).then((mode) => {
      updateSyncPill();
      if (mode === "cloud" || isCloud()) {
        return Promise.resolve(cloudCall("bootSync")).then(() => {
          firstSyncDone = true;
          externalChange();
          updateSyncPill();
          cloudCall("startPolling");
        });
      }
      // Mode local confirmé (pas de nouvelle tentative en arrière-plan) : rien à attendre.
      if (cloudStatus() === "local") { firstSyncDone = true; externalChange(); }
      return null;
    }).catch((e) => { console.warn("Initialisation cloud :", e); firstSyncDone = true; updateSyncPill(); externalChange(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
