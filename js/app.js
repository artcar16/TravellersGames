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
  const LOGO = "assets/logo.svg?v=3";

  /** Petits états d'interface conservés entre deux rendus. */
  const ui = { q: "", plq: "", corrQ: "", corrAll: false, bulkOpen: false };

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

  function plural(n, one, many) { return n + " " + (n > 1 ? (many || one + "s") : one); }
  function ordinal(n) { return n === 1 ? "1er" : n + "e"; }
  function signed(n) { return n > 0 ? "+" + n : n < 0 ? "−" + Math.abs(n) : "0"; }
  function pname(t, pid) { return Store.playerName(t, pid); }
  function shortName(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return parts[0] || "";
    return parts[0] + " " + parts[1].charAt(0).toUpperCase() + ".";
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
    if (!st.drawn) return { cls: "warn", label: "Inscriptions" };
    if (!st.phase1.done) return { cls: "gold live", label: "Phase 1 · " + st.phase1.played + "/" + st.phase1.total };
    if (!st.champion) {
      const r = firstOpenRound(st.main.rounds);
      return { cls: "gold live", label: "Tableau final" + (r ? " · " + shortRound(st.main.totalRounds, r) : "") };
    }
    const champ = pname(t, st.champion);
    if (st.consolante && !st.consolante.champion) return { cls: "gold live", label: "🏆 " + champ + " · consolante en cours" };
    return { cls: "ok", label: "Terminé · 🏆 " + champ };
  }

  function pillHtml(cls, label) { return `<span class="pill ${cls}"><i></i>${esc(label)}</span>`; }

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
  /** Décrit la provenance d'un adversaire inconnu (HTML, noms échappés). */
  function srcHtml(t, st, src, depth) {
    depth = depth || 0;
    if (!src) return "votre adversaire";
    if (src.type === "rep") return "le repêché n°" + src.k;
    if (src.type === "exempt") return `<b>${esc(pname(t, src.pid))}</b>`;
    if (src.type !== "p1" && src.type !== "winner") return "votre adversaire";
    const m = st.byId[src.matchId];
    if (!m) return "votre adversaire";
    const side = (slot) => {
      const pid = m["p" + slot];
      if (pid === "BYE") return "exempt";
      if (pid) return `<b>${esc(pname(t, pid))}</b>`;
      return depth >= 1 ? "?" : "(" + srcHtml(t, st, m["src" + slot], depth + 1) + ")";
    };
    return "le vainqueur du match " + side(1) + " – " + side(2);
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
          sub: `Votre adversaire est prêt · ${esc(stageLabel(st, m, true))} · en ${m.points} points`,
        };
      }
      case "wait": {
        const m = s.match, w = s.waitFor || {};
        const pre = m.stage === "cons" ? "Consolante — " : (picked && ctx.justPicked ? "Repêché ! " : "");
        const where = `${esc(stageLabel(st, m, true))} · en ${m.points} points`;
        if (w.type === "rep") {
          return { cls: "wait", icon: "⏳", title: `${pre}Attendez la fin de la phase 1 (repêchés)`, sub: `Vous affronterez le repêché n°${w.k} (meilleur perdant) · ${where}` };
        }
        const sm = w.matchId ? st.byId[w.matchId] : null;
        const running = sm && sm.status === "ready" ? " · ce match est en cours" : "";
        return { cls: "wait", icon: "⏳", title: `${pre}Attendez ${srcHtml(t, st, w)}`, sub: `Prochain match : ${where}${running}` };
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
          sub: `${s.inZone ? "Dans la zone pour l’instant" : "Hors zone pour l’instant"} (${s.pf} pts marqués) · réponse en fin de phase 1${!s.inZone && consFuture ? " — sinon consolante" : ""}`,
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
      case "repechable": return s.needed ? [s.inZone ? "rep in" : "rep", "Repêchable n°" + s.rank] : ["out", "Perdu · phase 1"];
      case "champion": return ["champ", "🏆 Champion"];
      case "consoleChampion": return ["champ", "🏆 Consolante"];
      case "notDrawn": return ["neutral", "Inscrit"];
      default: return ["out", "Éliminé"];
    }
  }

  // ============================================================
  //  Toast
  // ============================================================
  function toast(msg, kind, action) {
    let wrap = $(".toast-wrap");
    if (!wrap) { wrap = el('<div class="toast-wrap" role="status" aria-live="polite"></div>'); document.body.appendChild(wrap); }
    const node = el(`<div class="toast ${kind || ""}"><span>${esc(msg)}</span></div>`);
    let gone = false;
    const dismiss = () => { if (gone) return; gone = true; node.classList.add("out"); setTimeout(() => node.remove(), 300); };
    if (action) {
      const b = el(`<button type="button">${esc(action.label)}</button>`);
      b.onclick = () => { try { action.fn(); } finally { dismiss(); } };
      node.appendChild(b);
    }
    wrap.appendChild(node);
    setTimeout(dismiss, action ? 6000 : 2800);
  }

  // ============================================================
  //  Modales (feuille du bas sur mobile)
  // ============================================================
  const modalStack = [];
  function modal(o) {
    const root = document.getElementById("modal-root") || document.body;
    const overlay = el('<div class="modal-overlay"></div>');
    const box = el(`<div class="modal ${o.cls || ""}" role="dialog" aria-modal="true"></div>`);
    let closed = false;
    const api = {
      overlay, box, body: null, foot: null, onEnter: o.onEnter || null, dismissible: o.dismissible !== false,
      close(reason) {
        if (closed) return;
        closed = true;
        overlay.classList.add("closing");
        const i = modalStack.indexOf(api);
        if (i >= 0) modalStack.splice(i, 1);
        setTimeout(() => overlay.remove(), 170);
        if (o.onClose) { try { o.onClose(reason); } catch (e) { console.error(e); } }
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
      const b = el(`<button type="button" class="btn ${a.cls || ""}">${esc(a.label)}</button>`);
      b.onclick = () => a.onClick(api.close, b);
      api.foot.appendChild(b);
    });
    box.appendChild(api.foot);
    overlay.appendChild(box);
    overlay.addEventListener("click", (e) => { if (e.target === overlay && api.dismissible) api.close("backdrop"); });
    root.appendChild(overlay);
    modalStack.push(api);
    const hover = window.matchMedia && window.matchMedia("(hover: hover)").matches;
    if (o.autofocus !== false && hover) {
      const f = api.body.querySelector("input:not([type=checkbox]),textarea,select");
      if (f) setTimeout(() => f.focus(), 40);
    }
    return api;
  }
  function anyModalOpen() { return modalStack.length > 0; }

  document.addEventListener("keydown", (e) => {
    const top = modalStack[modalStack.length - 1];
    if (!top) return;
    if (e.key === "Escape" && top.dismissible) { e.preventDefault(); top.close("esc"); }
    else if (e.key === "Enter" && top.onEnter && !(e.target && e.target.tagName === "TEXTAREA")) { e.preventDefault(); top.onEnter(); }
  });

  /** Confirmation (promesse → true/false). */
  function ask(o) {
    return new Promise((resolve) => {
      let yes = false;
      const m = modal({
        title: o.title, cls: "ask",
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
  function numField(label, value, min, max, hint) {
    const node = el(`<div class="numfield">
      <div class="nf-label">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ""}</div>
      <div class="stepper sm">
        <button type="button" class="minus" aria-label="Moins">−</button>
        <input type="number" inputmode="numeric" min="${min}" max="${max}" value="${value}" aria-label="${esc(label)}" />
        <button type="button" class="plus" aria-label="Plus">+</button>
      </div></div>`);
    const input = node.querySelector("input");
    const clamp = (v) => Math.max(min, Math.min(max, v));
    const get = () => { const v = parseInt(input.value, 10); return Number.isFinite(v) ? clamp(v) : value; };
    node.querySelector(".minus").onclick = () => { input.value = clamp(get() - 1); };
    node.querySelector(".plus").onclick = () => { input.value = clamp(get() + 1); };
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

  function route(pattern, handler) {
    const keys = [];
    const rx = new RegExp("^" + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return "([^/]+)"; }) + "$");
    routes.push({ rx, keys, handler });
  }
  function navigate(hash) { if (location.hash === hash) render(); else location.hash = hash; }
  function parseHash() { const h = location.hash.replace(/^#/, ""); return h || "/"; }
  function isTreePath(p) { return /^\/t\/[^/]+\/bracket$/.test(p); }

  function render(opts) {
    opts = opts || {};
    if (viewCleanup) { try { viewCleanup(); } catch (e) { console.error(e); } viewCleanup = null; }
    live = null;
    pendingRefresh = false;
    const path = parseHash();
    const same = path === currentPath;
    currentPath = path;
    const y = window.scrollY;
    document.body.classList.toggle("fullbleed", isTreePath(path));
    clear($app);
    let matched = false;
    for (const r of routes) {
      const m = path.match(r.rx);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      try { r.handler(params); } catch (e) {
        console.error(e);
        clear($app);
        $app.appendChild(el(`<div class="card empty"><div class="ico">⚠︎</div><h2>Erreur d’affichage</h2><p>${esc(e && e.message)}</p><a class="btn" href="#/">Accueil</a></div>`));
      }
      matched = true;
      break;
    }
    if (!matched) $app.appendChild(el('<div class="empty"><div class="ico">🧭</div><p>Page introuvable.</p><a class="btn" href="#/">Retour à l’accueil</a></div>'));
    if (opts.keepScroll && same) window.scrollTo(0, y); else window.scrollTo(0, 0);
    renderNav();
  }

  function renderNav() {
    const m = parseHash().match(/^\/t\/([^/]+)/);
    let title = "The Travellers — Backgammon";
    if (m) { const t = Store.getTournament(decodeURIComponent(m[1])); if (t) title = t.name + " — The Travellers"; }
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
    if (isBusy()) { pendingRefresh = true; return; }
    render({ keepScroll: true });
  }
  /** Re-rendu local après une action (garde la position de défilement). */
  function refresh() { render({ keepScroll: true }); }

  function notFound() {
    document.body.classList.remove("fullbleed");
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
      const badge = k === "scores" && st.drawn && st.progress.ready ? `<span class="tab-badge">${st.progress.ready}</span>` : "";
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
      foot = `<div class="mini-prog"><div class="bar"><i style="width:${pct}%"></i></div><span>${st.progress.played}/${st.progress.total} matchs${st.progress.ready ? ` · <b>${st.progress.ready} à jouer</b>` : ""}</span></div>`;
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

  function cleanNames(text) {
    return String(text || "").split(/\r?\n/).map((n) => n.replace(/^\s*\d+[.)-]\s*/, "").trim()).filter(Boolean);
  }

  function playersBefore(tid) {
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
      input.focus();
      if (dup) toast("Attention : « " + name + " » est déjà inscrit (doublon).", "warn");
      drawDyn();
    };

    const det = entry.querySelector("details");
    const ta = entry.querySelector("textarea");
    const cnt = entry.querySelector(".bulk-count");
    const bulkBtn = entry.querySelector(".bulk-foot .btn");
    det.addEventListener("toggle", () => { ui.bulkOpen = det.open; });
    const countNames = () => {
      const n = cleanNames(ta.value).length;
      cnt.textContent = n ? plural(n, "nom détecté", "noms détectés") : "Aucun nom détecté";
      bulkBtn.disabled = !n;
      bulkBtn.textContent = n ? "Ajouter " + plural(n, "joueur") : "Ajouter la liste";
    };
    ta.addEventListener("input", countNames);
    bulkBtn.onclick = () => {
      const t = Store.getTournament(tid);
      if (!t) return;
      const names = cleanNames(ta.value);
      const existing = new Set(t.players.map((x) => norm(x.name)));
      const dups = names.filter((n) => existing.has(norm(n))).length;
      const r = Store.addPlayers(tid, ta.value);
      if (r.error) { toast(r.error, "err"); return; }
      ta.value = "";
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
        <div class="tile"><b>${pi.pl.phase1Matches}</b><span>match${pi.pl.phase1Matches > 1 ? "s" : ""} de phase 1${pi.pl.exempt ? " + 1 exempt" : ""}</span></div>
        <div class="tile"><b>${pi.pl.size}</b><span>au tableau final</span></div>
        <div class="tile"><b>${pi.pl.repechage}</b><span>repêché${pi.pl.repechage > 1 ? "s" : ""}</span></div>
        <div class="tile"><b>${pi.consOn && pi.pl.consolante >= 2 ? pi.pl.consolante : "—"}</b><span>en consolante</span></div>
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
      ${sectionTitle("Joueurs inscrits", `<span class="count-badge">${n}</span>`)}
      ${n ? '<ol class="plist"></ol><div class="list-foot"><span class="muted small">Touchez un nom pour le modifier.</span><button type="button" class="btn ghost sm clear-all">Tout retirer</button></div>' : '<div class="empty slim"><p>Aucun joueur pour l’instant. Tapez un nom ci-dessus ou collez une liste.</p></div>'}
    </section>`);
    const ol = card.querySelector(".plist");
    if (ol) {
      t.players.forEach((p, i) => {
        const li = el(`<li>
          <button type="button" class="pl-name"><span class="pl-num">${i + 1}</span><span class="pl-txt">${esc(p.name)}</span>${counts[norm(p.name)] > 1 ? '<span class="pill warn sm"><i></i>doublon</span>' : ""}</button>
          <button type="button" class="pl-x" aria-label="Retirer ${esc(p.name)}" title="Retirer">✕</button>
        </li>`);
        li.querySelector(".pl-name").onclick = () => openPlayerEdit(t.id, p.id, redraw);
        li.querySelector(".pl-x").onclick = () => {
          const keep = Object.assign({}, p);
          const r = Store.removePlayer(t.id, p.id);
          if (r.error) { toast(r.error, "err"); return; }
          redraw();
          toast(keep.name + " retiré", "", { label: "Annuler", fn: () => { Store.addPlayer(t.id, keep.name, { club: keep.club, rating: keep.rating, note: keep.note }); redraw(); } });
        };
        ol.appendChild(li);
      });
      card.querySelector(".clear-all").onclick = () => {
        ask({ title: "Retirer tous les joueurs ?", text: `Les ${n} joueurs inscrits seront retirés de la liste.`, ok: "Tout retirer", danger: true }).then((ok) => {
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
      const r = Store.updatePlayer(tid, pid, data);
      if (r.error) { toast(r.error, "err"); return; }
      close();
      toast("Joueur modifié.");
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
      <div class="ib-txt"><strong>Tirage effectué — inscriptions closes.</strong><br/><span class="muted">${plural(t.players.length, "joueur")} · ${plural(nScores, "match joué", "matchs joués")} sur ${st.progress.total}${st.exempt ? " · exempt : " + esc(pname(t, st.exempt)) : ""}</span></div>
    </div>`);
    if (!nScores) {
      const b = el('<button type="button" class="btn subtle sm">Modifier la liste</button>');
      b.onclick = () => ask({ title: "Modifier la liste des joueurs ?", text: "Le tirage au sort sera annulé (aucun score n’a encore été saisi). Il faudra relancer le tirage ensuite.", ok: "Annuler le tirage" }).then((ok) => {
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

    function draw() {
      const q = norm(ui.plq);
      const list = rows.filter((r) => !q || norm(r.p.name).includes(q));
      tableCard.innerHTML = `<table class="table rank-table"><thead><tr><th class="rank">#</th><th>Joueur</th><th class="num">J</th><th class="num">V</th><th class="num">Pts</th><th class="num hide-mobile">Diff.</th></tr></thead><tbody></tbody></table>`;
      const tb = tableCard.querySelector("tbody");
      list.forEach((r) => {
        const c = chipFor(st, r.p.id, r.status);
        const diff = r.s.pointsFor - r.s.pointsAgainst;
        const tr = el(`<tr class="clickable">
          <td class="rank">${rows.indexOf(r) + 1}</td>
          <td><div class="pl-cell"><strong>${esc(r.p.name)}</strong>${pillHtml(c[0], c[1])}</div></td>
          <td class="num">${r.s.played}</td><td class="num">${r.s.wins}</td><td class="num">${r.s.pointsFor}</td>
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
      return `<div class="hist-row"><span class="res ${won ? "w" : "l"}">${won ? "V" : "D"}</span><span class="hr-main"><span class="nm">${esc(pname(t, m.p1 === pid ? m.p2 : m.p1))}</span><small>${esc(stageLabel(st, m, true))}</small></span><span class="sc">${mine}–${opp}</span></div>`;
    }).join("")}</div>` : '<p class="muted small">Aucun match joué pour l’instant.</p>';
    const body = [
      el(statusCardHtml(info)),
      el(`<div class="stat-row compact"><div class="stat"><div class="n">${stats.played}</div><div class="l">Joués</div></div><div class="stat"><div class="n">${stats.wins}</div><div class="l">Victoires</div></div><div class="stat"><div class="n">${stats.pointsFor}</div><div class="l">Points</div></div><div class="stat"><div class="n">${signed(stats.pointsFor - stats.pointsAgainst)}</div><div class="l">Diff.</div></div></div>`),
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

    const search = el(`<div class="search-bar"><input type="search" placeholder="Trouver un joueur…" value="${esc(ui.q)}" aria-label="Trouver un joueur" /></div>`);
    const found = el('<div class="found"></div>');
    const readySec = el('<section class="sec ready-sec"></section>');
    $app.appendChild(search);
    $app.appendChild(found);
    $app.appendChild(readySec);

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
      readySec.innerHTML = sectionTitle("À jouer maintenant", `<span class="count-badge gold">${total}</span>`) +
        `<p class="sec-sub muted">${waiting ? plural(waiting, "match", "matchs") + " en attente d’un adversaire" : (total ? "Tous les adversaires sont connus" : "")}${q && total ? ` · filtre « ${esc(ui.q.trim())} »` : ""}</p>`;
      const list = el('<div class="ready-list"></div>');
      if (!ready.length) {
        const allDone = st.progress.total > 0 && st.progress.played === st.progress.total;
        list.appendChild(el(`<div class="empty slim"><p>${q ? "Aucun match à jouer pour ce joueur." : allDone ? "Tous les matchs sont joués. 🎉" : "Aucun match prêt : en attente de résultats."}</p></div>`));
      }
      ready.forEach((m) => {
        const row = el(`<button type="button" class="match-row stage-${m.stage}" data-match="${m.id}">
          <span class="mr-stage"><span class="stage-chip ${m.stage}">${esc(m.stage === "p1" && !m.isFinal ? "Phase 1 · " + (m.index + 1) : stageLabel(st, m))}</span></span>
          <span class="mr-players"><span class="mr-p">${esc(pname(t, m.p1))}</span><span class="vs">vs</span><span class="mr-p">${esc(pname(t, m.p2))}</span></span>
          <span class="mr-pts">en ${m.points}&nbsp;pts</span>
          <span class="mr-go" aria-hidden="true">›</span>
        </button>`);
        row.onclick = () => openScore(tid, m.id);
        list.appendChild(row);
      });
      readySec.appendChild(list);
    }
    search.querySelector("input").addEventListener("input", (e) => { ui.q = e.target.value; drawDynamic(); });
    drawDynamic();

    const recent = recentCard(t, st);
    if (recent) $app.appendChild(recent);
    const rep = repechageCard(t, st);
    if (rep) $app.appendChild(rep);
  });

  function progRow(label, done, total, note, cls) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return `<div class="prog ${cls || ""}"><div class="prog-head"><span class="prog-label">${label}</span><span class="prog-val">${note != null ? note : `${done}<small>/${total}</small>`}</span></div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
  }

  function progressCard(t, st) {
    const rows = [];
    if (st.main.size === 1) {
      rows.push(progRow("Finale", st.phase1.played, 1, null, st.champion ? "done" : ""));
    } else {
      rows.push(progRow("Phase 1", st.phase1.played, st.phase1.total, null, st.phase1.done ? "done" : ""));
      const mm = realMatches([].concat.apply([], st.main.rounds));
      rows.push(progRow("Tableau final" + (st.main.size ? ` · ${st.main.size}` : ""), countDone(mm), mm.length, null, st.champion ? "done" : ""));
      if (st.consolante) {
        const cm = realMatches([].concat.apply([], st.consolante.rounds));
        rows.push(progRow(`Consolante · ${st.consolante.entrants.length}`, countDone(cm), cm.length, null, st.consolante.champion ? "done" : ""));
      } else if (t.settings.consolante !== false && st.plan.ok && st.plan.consolante >= 2) {
        rows.push(progRow("Consolante", 0, 1, `<small>après la phase 1 · ${st.plan.consolante} joueurs</small>`, "later"));
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
        <span class="rr-score"><b>${esc(pname(t, m.winner))}</b> <span class="sc">${w1 ? m.score1 : m.score2}–${w1 ? m.score2 : m.score1}</span> <span class="lo">${esc(pname(t, m.loser))}</span></span>
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
    const card = el(`<section class="card rep-card">
      ${sectionTitle("Repêchage", final ? pillHtml("ok", "Définitif") : pillHtml("warn", "Provisoire"))}
      <p class="muted small">${plural(R, "place")} au tableau final pour les meilleurs perdants de la phase 1 · classement : points marqués, puis différentiel, puis tirage au sort.${final ? "" : ` <b>${plural(remaining, "match", "matchs")} de phase 1 restant${remaining > 1 ? "s" : ""}.</b>`}</p>
      <table class="table rep-table"><thead><tr><th class="rank">Rang</th><th>Perdant</th><th class="num">Pts</th><th class="num">Diff.</th><th></th></tr></thead><tbody></tbody></table>
    </section>`);
    const tb = card.querySelector("tbody");
    if (!rk.length) tb.appendChild(el('<tr><td colspan="5" class="muted center">Aucun perdant pour l’instant.</td></tr>'));
    rk.forEach((x, i) => {
      tb.appendChild(el(`<tr class="${x.inZone ? "in" : "outz"}">
        <td class="rank">${x.rank}</td><td>${esc(pname(t, x.pid))}</td><td class="num"><b>${x.pf}</b></td><td class="num">${signed(x.diff)}</td>
        <td class="tag-cell">${x.picked ? pillHtml("gold", "Repêché") : (x.inZone ? '<span class="star">★</span>' : (final && consOn ? pillHtml("cons", "Consolante") : ""))}</td></tr>`));
      if (i === R - 1) tb.appendChild(el(`<tr class="cut"><td colspan="5"><span>Ligne de repêchage · ${plural(R, "place")}${consOn && st.plan.consolante >= 2 ? " — en dessous : consolante" : ""}</span></td></tr>`));
    });
    if (rk.length && rk.length < R) tb.appendChild(el(`<tr class="cut open"><td colspan="5"><span>${plural(R - rk.length, "place encore libre", "places encore libres")}</span></td></tr>`));
    return card;
  }

  // ============================================================
  //  Saisie d'un score (modale) + pop-up de résultat
  // ============================================================
  /** Matchs joués qui seraient annulés si ce match avait le score (a, b). */
  function impactOf(tid, matchId, a, b) {
    const t = Store.getTournament(tid);
    if (!t || !t.draw) return [];
    const cur = Store.state(t);
    const cm = cur.byId[matchId];
    if (!cm) return [];
    if (typeof Store._computeState !== "function") return Store.clearImpact(t, matchId);
    const clone = Object.assign({}, t, { scores: Object.assign({}, t.scores) });
    clone.scores[matchId] = { s1: a, s2: b, p1: cm.p1, p2: cm.p2, draw: t.draw.id, at: Date.now() };
    const sim = Store._computeState(clone);
    return cur.all.filter((x) => x.id !== matchId && !x.bye && x.status === "done" && !(sim.byId[x.id] && sim.byId[x.id].status === "done" && sim.byId[x.id].winner === x.winner));
  }

  function impactHtml(t, st, list, subject) {
    if (!list.length) return "";
    const items = list.slice(0, 8).map((m) => `<li><span class="im-stage">${esc(stageLabel(st, m))}</span> ${esc(pname(t, m.p1))} <b>${m.score1}–${m.score2}</b> ${esc(pname(t, m.p2))}</li>`).join("");
    return `<div class="impact"><div class="impact-title">⚠ ${subject} annulera ${plural(list.length, "match")} déjà joué${list.length > 1 ? "s" : ""}</div><ul>${items}${list.length > 8 ? `<li>… et ${list.length - 8} autre(s)</li>` : ""}</ul><div class="impact-note">Ces matchs repasseront « à jouer » ou « en attente » : leurs scores actuels ne compteront plus.</div></div>`;
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
    const target = m.points;
    const v = m.status === "done" ? [m.score1, m.score2] : [0, 0];
    const orig = v.slice();

    const titleHtml = `<div class="sm-stage">${esc(stageLabel(st0, m, true))}</div><h3>${overwrite ? "Corriger le score" : "Saisir le score"}</h3><div class="sm-target">Match en <b>${target}</b> points</div>`;
    const rows = P.map((pid, i) => el(`<div class="sm-row">
      <div class="sm-name"><span class="nm">${esc(names[i])}</span><span class="win-tag">Vainqueur</span></div>
      <div class="sm-ctrl">
        <button type="button" class="target-chip" title="Mettre ${target} points" aria-label="${esc(names[i])} : ${target} points">${target}</button>
        <div class="stepper big">
          <button type="button" class="minus" aria-label="Moins">−</button>
          <input type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="99" value="${v[i]}" aria-label="Score de ${esc(names[i])}" />
          <button type="button" class="plus" aria-label="Plus">+</button>
        </div>
      </div></div>`));
    const hint = el('<div class="sm-hint" aria-live="polite"></div>');
    const impact = el('<div class="sm-impact"></div>');
    const saveBtn = el('<button type="button" class="btn big block save-btn">Enregistrer</button>');
    const md = modal({ titleHtml, cls: "score-modal", body: rows.concat([hint, impact]), autofocus: false });
    md.foot.appendChild(saveBtn);

    let impactList = [];
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
        saveBtn.disabled = false;
        const w = a > b ? 0 : 1;
        saveBtn.textContent = `Valider · ${shortName(names[w])} gagne ${Math.max(a, b)}–${Math.min(a, b)}`;
        if (Math.max(a, b) < target) { hint.classList.add("warn"); hint.textContent = `Score inhabituel : personne n’a atteint ${target} points.`; }
        else if (Math.min(a, b) >= target) { hint.classList.add("warn"); hint.textContent = `Score inhabituel : les deux joueurs ont ${target} points ou plus.`; }
      }
      if (overwrite) {
        const changed = a !== orig[0] || b !== orig[1];
        impactList = changed && a !== b ? impactOf(tid, matchId, a, b) : [];
        const t = Store.getTournament(tid);
        impact.innerHTML = impactList.length ? impactHtml(t, Store.state(t), impactList, "Ce changement") : (changed && a !== b ? '<div class="impact ok">Aucun autre match n’est affecté.</div>' : "");
        if (!changed) { saveBtn.disabled = true; saveBtn.textContent = "Modifiez le score"; }
      }
    }
    rows.forEach((r, i) => {
      const inp = r.querySelector("input");
      r.querySelector(".minus").onclick = () => { v[i] = Math.max(0, v[i] - 1); update(); };
      r.querySelector(".plus").onclick = () => { v[i] = Math.min(99, v[i] + 1); update(); };
      r.querySelector(".target-chip").onclick = () => { v[i] = target; update(); };
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
      const r = Store.recordScore(tid, matchId, a, b, { overwrite });
      if (r.error) { toast(r.error, "err"); return; }
      md.close("saved");
      refresh();
      showResult(tid, r.outcome, { corrected: overwrite });
    }
    function save() {
      const a = v[0], b = v[1];
      if (a === b) { hint.className = "sm-hint err"; hint.textContent = "Pas d’égalité au backgammon : il faut un vainqueur."; return; }
      if (saveBtn.disabled) return;
      const unusual = Math.max(a, b) < target || Math.min(a, b) >= target;
      const checks = [];
      if (unusual) checks.push(`<p>Score inhabituel pour un match en <b>${target}</b> points :<br/><b>${esc(names[0])} ${a} – ${b} ${esc(names[1])}</b></p>`);
      if (overwrite && impactList.length) checks.push(`<p>${plural(impactList.length, "match déjà joué sera annulé", "matchs déjà joués seront annulés")}.</p>`);
      if (!checks.length) { doSave(); return; }
      ask({ title: unusual ? "Confirmer ce score ?" : "Confirmer la correction ?", html: checks.join(""), ok: "Confirmer" }).then((ok) => { if (ok) doSave(); });
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
    const ws = w1 ? m.score1 : m.score2, ls = w1 ? m.score2 : m.score1;
    const W = pname(t, o.winner), L = pname(t, o.loser);
    const wInfo = statusInfo(t, st, o.winner, o.winnerStatus, { justPicked: o.phase1Completed });
    const lInfo = statusInfo(t, st, o.loser, o.loserStatus, { justPicked: o.phase1Completed });
    const parts = [];
    const champ = o.champion || o.consoleChampion;
    if (champ) {
      parts.push(`<div class="celebrate">${confetti(28)}<img src="${LOGO}" alt="" class="crest" /><div class="cel-eyebrow">${o.champion ? "Champion du tournoi" : "Vainqueur de la consolante"}</div><div class="cel-name">🏆 ${esc(pname(t, champ))}</div></div>`);
    }
    parts.push(`<div class="res-head"><span class="res-check">✓</span><div class="res-main"><div class="res-line"><b>${esc(W)}</b> <span class="res-sc">${ws} – ${ls}</span> <span class="lo">${esc(L)}</span></div><div class="res-stage">${esc(stageLabel(st, m, true))} · ${opts.corrected ? "score corrigé" : "résultat enregistré"}</div></div></div>`);
    parts.push(`<div class="pcard win"><div class="pc-head"><span class="pc-name">${esc(W)}</span>${pillHtml("gold", "Gagne")}</div>${statusCardHtml(wInfo)}</div>`);
    parts.push(`<div class="pcard lose"><div class="pc-head"><span class="pc-name">${esc(L)}</span>${pillHtml("out", "Perd")}</div>${statusCardHtml(lInfo)}</div>`);
    if (o.phase1Completed) {
      const rp = o.repechage || st.repechage;
      const picks = rp.picks.map((pid) => `<span class="chip gold">${esc(pname(t, pid))}</span>`).join(" ");
      const consTxt = st.consolante ? `Consolante lancée (${st.consolante.entrants.length} joueurs)` : (t.settings.consolante !== false ? "Pas de consolante (pas assez de joueurs)" : "");
      parts.push(`<div class="p1-done"><div class="p1d-title">Phase 1 terminée !</div><div class="p1d-line">${rp.needed ? `Repêchés : ${picks}` : "Aucun repêchage : le tableau final est complet."}</div>${consTxt ? `<div class="p1d-line">${esc(consTxt)}</div>` : ""}</div>`);
    }
    const md = modal({
      title: null, cls: "result-modal" + (champ ? " is-champion" : ""),
      body: parts.map((h) => el(h)),
      actions: [
        { label: "Voir l’arbre", cls: "subtle", onClick: (c) => { c(); navigate("#/t/" + encodeURIComponent(tid) + "/bracket"); } },
        { label: "Continuer", onClick: (c) => c() },
      ],
    });
    md.onEnter = () => md.close();
  }

  // ============================================================
  //  VUE : Réglages
  // ============================================================
  route("/t/:id/settings", function (p) {
    const t = Store.getTournament(p.id);
    if (!t) return notFound();
    const st = shell(t, "settings");
    const tid = t.id;
    const s = t.settings;

    // --- Informations ---
    const infoC = el(`<section class="card">${sectionTitle("Informations")}<div class="form-grid">
      ${field("Nom du tournoi", `<input type="text" name="name" value="${esc(t.name)}" maxlength="80" />`)}
      ${field("Date", `<input type="date" name="date" value="${esc(t.date || "")}" />`)}
    </div></section>`);
    $app.appendChild(infoC);

    // --- Points ---
    const K = st.drawn ? st.main.totalRounds : (st.plan.ok ? st.plan.mainRounds : 3);
    const ptsC = el(`<section class="card">${sectionTitle("Points par match")}<p class="muted small">Nombre de points à atteindre pour gagner un match. ${st.drawn ? "Tours du tableau tiré au sort." : st.plan.ok ? "Tours prévus pour " + plural(t.players.length, "joueur") + "." : "Les tours affichés s’adapteront au nombre de joueurs."}</p><div class="num-grid"></div></section>`);
    const grid = ptsC.querySelector(".num-grid");
    const fP1 = numField("Phase 1", s.pointsPhase1, 1, 99);
    if (K > 0) grid.appendChild(fP1.node);
    const roundFields = [];
    if (K === 0) {
      const f = numField("Finale (match unique)", s.mainPoints[0], 1, 99);
      roundFields.push({ idx: 0, f });
      grid.appendChild(f.node);
    } else {
      for (let r = 1; r <= K; r++) {
        const f = numField(Store.roundName(K, r), s.mainPoints[K - r], 1, 99);
        roundFields.push({ idx: K - r, f });
        grid.appendChild(f.node);
      }
    }
    const fCons = numField("Consolante (tous les tours)", s.consolePoints, 1, 99);
    grid.appendChild(fCons.node);
    $app.appendChild(ptsC);

    // --- Format & affichage ---
    const fmtC = el(`<section class="card">${sectionTitle("Consolante & affichage")}
      <label class="toggle"><input type="checkbox" name="consolante" ${s.consolante ? "checked" : ""}/><span class="track"></span><span class="tg-txt">Consolante<small>Les perdants non repêchés jouent un second tableau, lancé automatiquement à la fin de la phase 1.</small></span></label>
      <hr class="divider"/>
      <label class="toggle"><input type="checkbox" name="autoRotate" ${s.autoRotate ? "checked" : ""}/><span class="track"></span><span class="tg-txt">Rotation automatique des arbres<small>L’écran public alterne entre l’arbre principal et la consolante.</small></span></label>
      <div class="rot-secs"></div>
    </section>`);
    const fRot = numField("Durée d’affichage de chaque arbre (secondes)", s.rotateSeconds, 5, 99);
    fmtC.querySelector(".rot-secs").appendChild(fRot.node);
    $app.appendChild(fmtC);

    // --- Règlement ---
    const rulesC = el(`<section class="card">${sectionTitle("Règlement")}<textarea name="rules" rows="5">${esc(s.rules || "")}</textarea></section>`);
    $app.appendChild(rulesC);

    const saveBar = el('<div class="save-bar"><button class="btn big" type="button">Enregistrer les réglages</button></div>');
    saveBar.querySelector("button").onclick = () => {
      const cur = Store.getTournament(tid);
      if (!cur) return;
      const mp = cur.settings.mainPoints.slice();
      roundFields.forEach((x) => { mp[x.idx] = x.f.get(); });
      Store.updateTournament(tid, {
        name: infoC.querySelector("[name=name]").value,
        date: infoC.querySelector("[name=date]").value,
        settings: {
          pointsPhase1: fP1.get(), mainPoints: mp, consolePoints: fCons.get(),
          consolante: fmtC.querySelector("[name=consolante]").checked,
          autoRotate: fmtC.querySelector("[name=autoRotate]").checked,
          rotateSeconds: fRot.get(),
          rules: rulesC.querySelector("[name=rules]").value,
        },
      });
      if (document.activeElement) document.activeElement.blur();
      refresh();
      toast("Réglages enregistrés ✓");
    };
    $app.appendChild(saveBar);

    // --- Tirage ---
    const drawC = el(`<section class="card">${sectionTitle("Tirage au sort")}</section>`);
    if (t.draw) {
      const n = countDone(realMatches(st.all));
      drawC.appendChild(el(`<p class="muted">Tirage effectué le ${esc(new Date(t.draw.at).toLocaleDateString("fr-FR"))} à ${esc(fmtTime(t.draw.at))} · ${plural(t.draw.n, "joueur")} · <b>${plural(n, "score saisi", "scores saisis")}</b></p>`));
      const row = el('<div class="btn-row"></div>');
      const redo = el('<button class="btn subtle" type="button">🎲 Refaire le tirage</button>');
      const undo = el('<button class="btn danger" type="button">Annuler le tirage</button>');
      redo.onclick = () => ask({ title: "Refaire le tirage ?", html: `<p>Un nouveau tirage au sort recompose toutes les paires.${n ? ` <b>Les ${plural(n, "score saisi", "scores saisis")} seront effacés.</b>` : ""}</p>`, ok: "Refaire le tirage", danger: n > 0 }).then((ok) => {
        if (!ok) return;
        const r = Store.drawTournament(tid);
        if (r.error) toast(r.error, "err"); else { refresh(); toast("Nouveau tirage effectué."); }
      });
      undo.onclick = () => ask({ title: "Annuler le tirage ?", html: `<p>Retour aux inscriptions (la liste des joueurs redevient modifiable).${n ? ` <b>Les ${plural(n, "score saisi", "scores saisis")} seront effacés.</b>` : ""}</p>`, ok: "Annuler le tirage", cancel: "Garder", danger: true }).then((ok) => {
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
    del.onclick = () => ask({ title: "Supprimer ce tournoi ?", html: `<p>« <b>${esc(t.name)}</b> » sera supprimé définitivement, avec tous ses scores${isCloud() ? ", pour tout le monde" : ""}.</p>`, ok: "Supprimer", danger: true }).then((ok) => {
      if (!ok) return;
      Store.deleteTournament(tid);
      navigate("#/");
      toast("Tournoi supprimé.");
    });
    dz.querySelector(".btn-row").appendChild(exp);
    dz.querySelector(".btn-row").appendChild(del);
    $app.appendChild(dz);

    if (/corrections/.test(location.hash) || ui.scrollToCorr) {
      ui.scrollToCorr = false;
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
    const card = el(`<section class="card" id="corrections">${sectionTitle("Corrections", `<span class="count-badge">${done.length}</span>`)}
      <p class="muted small">Corriger ou effacer un score déjà saisi. Si le vainqueur change, les matchs qui en dépendent sont signalés avant validation.</p>
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
            <span class="cr-score"><b>${esc(pname(t, m.winner))}</b> <span class="sc">${w1 ? m.score1 : m.score2}–${w1 ? m.score2 : m.score1}</span> <span class="lo">${esc(pname(t, m.loser))}</span></span>
          </div>
          <div class="cr-actions"><button type="button" class="btn sm subtle fix">Corriger</button><button type="button" class="btn sm danger clr">Effacer</button></div>
        </div>`);
        row.querySelector(".fix").onclick = () => openScore(tid, m.id, { overwrite: true });
        row.querySelector(".clr").onclick = () => clearFlow(tid, m.id);
        list.appendChild(row);
      });
      if (rows.length < total) {
        const more = el(`<button type="button" class="btn ghost sm more">Afficher les ${total} matchs</button>`);
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
    const imp = Store.clearImpact(t, matchId);
    const html = `<p>Effacer le score <b>${esc(pname(t, m.p1))} ${m.score1} – ${m.score2} ${esc(pname(t, m.p2))}</b> (${esc(stageLabel(st, m, true))}) ? Le match repassera « à jouer ».</p>` +
      (imp.length ? impactHtml(t, st, imp, "L’effacement") : '<div class="impact ok">Aucun autre match n’est affecté.</div>');
    ask({ title: "Effacer un score", html, ok: "Effacer le score", danger: true }).then((ok) => {
      if (!ok) return;
      const r = Store.clearScore(tid, matchId);
      if (r.error) toast(r.error, "err"); else { refresh(); toast("Score effacé."); }
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
  const TR = { CW: 182, CH: 54, GX: 24, GY: 10, HEAD: 40, PAD: 14, BW: 300, BH: 82, BGAP: 24 };
  const tv = { tid: null, view: "main" };

  /** Colonnes de l'arbre → positions (miroir en paysage, gauche→droite sinon). */
  function layoutTree(levels, mirrored) {
    const step = TR.CW + TR.GX, row = TR.CH + TR.GY;
    const L = levels.length;
    const mir = mirrored && L >= 2;
    const pos = levels.map((lv) => new Array(lv.length));
    const half0 = levels[0].length / 2;
    for (let l = 0; l < L; l++) {
      const n = levels[l].length;
      for (let i = 0; i < n; i++) {
        let x, side = "L";
        if (!mir) x = l * step;
        else if (l === L - 1) { x = (L - 1) * step; side = "C"; }
        else { side = i < n / 2 ? "L" : "R"; x = side === "L" ? l * step : (2 * (L - 1) - l) * step; }
        let y;
        if (l === 0) y = (mir ? (i < half0 ? i : i - half0) : i) * row;
        else {
          const a = pos[l - 1][2 * i], b = pos[l - 1][2 * i + 1];
          y = b ? (a.y + b.y) / 2 : a.y;
        }
        pos[l][i] = { x, y, side };
      }
    }
    return { pos, mir, L };
  }

  /** Libellé d'un siège encore inconnu. */
  function tbdLabel(t, st, src, arrow) {
    if (!src) return "—";
    if (src.type === "rep") return "Repêché n°" + src.k;
    if (src.type === "exempt") return pname(t, src.pid);
    if (src.type === "p1" || src.type === "winner") {
      const sm = st.byId[src.matchId];
      if (sm && sm.p1 && sm.p2 && sm.p1 !== "BYE" && sm.p2 !== "BYE") return "Vainq. " + shortName(pname(t, sm.p1)) + " / " + shortName(pname(t, sm.p2));
      return "Vainqueur " + arrow;
    }
    return "—";
  }

  function trow(cls, name, sc, title) {
    return `<div class="r ${cls}"${title ? ` title="${esc(title)}"` : ""}><span class="n">${name}</span><span class="s">${sc == null ? "" : sc}</span></div>`;
  }

  function treeCard(t, st, node, info) {
    if (node.kind === "exempt") {
      const nm = pname(t, node.pid);
      return { cls: "leaf exempt", html: trow("in", esc(nm), "", nm) + trow("note", "Exempt · qualifié d’office", "") };
    }
    if (node.kind === "rep") {
      if (node.pid) {
        const r = st.repechage.ranking.find((x) => x.pid === node.pid);
        const nm = pname(t, node.pid);
        return { cls: "leaf rep known", html: trow("in", esc(nm), "", nm) + trow("note", "Repêché n°" + node.k + (r ? " · " + r.pf + " pts" : ""), "") };
      }
      return { cls: "leaf rep", html: trow("tbd", "Repêché n°" + node.k, "") + trow("note", "Meilleur perdant", "") };
    }
    const m = node.match;
    if (m.bye) {
      const who = m.p1 === "BYE" ? m.p2 : m.p1;
      const nm = pname(t, who);
      return { cls: "bye", html: trow("in", esc(nm), "", nm + " · exempt") + '<span class="tag muted">Exempt</span>' };
    }
    const seat = (slot) => {
      const pid = m["p" + slot];
      if (pid === "BYE") return trow("tbd", "Exempt", "");
      if (!pid) return trow("tbd", esc(tbdLabel(t, st, m["src" + slot], info.arrows[slot - 1])), "");
      const cls = m.status === "done" ? (m.winner === pid ? "win" : "lose") : "";
      const nm = pname(t, pid);
      return trow(cls, esc(nm), m["score" + slot], nm);
    };
    let cls = "match " + m.status;
    if (info.final) cls += " final";
    if (info.fresh) cls += " flash";
    const extra = m.status === "ready" ? '<span class="tag">À jouer</span><span class="pulse"></span>' : "";
    return { cls, html: seat(1) + seat(2) + extra };
  }

  function treeHtml(t, st, levels, cons, mirrored, isFresh) {
    const { CW, CH, HEAD, PAD, BH, BGAP } = TR;
    const lay = layoutTree(levels, mirrored);
    const pos = lay.pos, L = lay.L, mir = lay.mir;
    const f = pos[L - 1][0];
    const champ = cons ? st.consolante.champion : st.champion;
    const bTitle = cons ? "Vainqueur de la consolante" : "Champion";
    const champName = champ ? pname(t, champ) : "À venir";
    // largeur de la bannière estimée d'après le nom (le cadre reste exact pour l'ajustement)
    const BW = Math.round(Math.max(TR.BW, Math.min(560, Math.max(150 + champName.length * 14, 110 + bTitle.length * 9.8))));
    const bx = (mir || L === 1) ? f.x + CW / 2 - BW / 2 : f.x;
    const by = f.y - BGAP - BH;
    let minX = Math.min(0, bx), maxX = bx + BW, maxY = 0;
    pos.forEach((lv) => lv.forEach((p) => { maxX = Math.max(maxX, p.x + CW); maxY = Math.max(maxY, p.y + CH); }));
    const headY = Math.min(0, by) - HEAD;
    const ox = PAD - minX, oy = PAD - headY;
    const W = Math.ceil(maxX - minX + 2 * PAD), H = Math.ceil(maxY - headY + 2 * PAD);

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
    const head = (x, l) => {
      const lb = label(l);
      return `<div class="col-head${l === L - 1 ? " fin" : ""}" style="left:${x + ox}px;top:${headY + oy}px;width:${CW}px"><b>${esc(lb[0])}</b><span>${lb[1]} pts</span></div>`;
    };
    for (let l = 0; l < L; l++) {
      if (!mir || l === L - 1) heads += head(pos[l][0].x, l);
      else { heads += head(pos[l][0].x, l); heads += head(pos[l][levels[l].length - 1].x, l); }
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
          const cy = Math.round(c.y + CH / 2 + oy), py = Math.round(p.y + CH / 2 + oy);
          const sx = Math.round((c.side === "R" ? c.x : c.x + CW) + ox);
          const tx = Math.round((c.side === "R" ? p.x + CW : p.x) + ox);
          const mx = Math.round((sx + tx) / 2);
          const d = `M${sx} ${cy}H${mx}V${py}H${tx}`;
          const cn = levels[l - 1][2 * i + k];
          const fresh = cn.kind === "match" && isFresh(cn.match) ? ' class="fresh"' : "";
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
          return c.y < p.y ? "↑" : "↓";
        });
        const c = treeCard(t, st, node, { final: l === L - 1, arrows, fresh: node.kind === "match" && isFresh(node.match) });
        cards += `<div class="tc ${c.cls}" style="left:${Math.round(p.x + ox)}px;top:${Math.round(p.y + oy)}px"${node.match ? ` data-id="${node.match.id}"` : ""}>${c.html}</div>`;
      });
    }

    // Bannière champion
    const finM = levels[L - 1][0].match;
    const bStyle = `left:${Math.round(bx + ox)}px;top:${Math.round(by + oy)}px;width:${BW}px;height:${BH}px`;
    const banner = champ
      ? `<div class="t-banner won${finM && isFresh(finM) ? " fresh" : ""}" style="${bStyle}"><img src="${LOGO}" alt="" class="crest" /><div class="tb-txt"><div class="tb-eyebrow">${bTitle}</div><div class="tb-name">🏆 ${esc(pname(t, champ))}</div></div></div>`
      : `<div class="t-banner" style="${bStyle}"><span class="tb-cup">🏆</span><div class="tb-txt"><div class="tb-eyebrow">${bTitle}</div><div class="tb-name">À venir</div></div></div>`;

    return `<div class="tree ${cons ? "is-cons" : "is-main"} ${mir ? "mirrored" : "ltr"}" style="width:${W}px;height:${H}px;--cw:${CW}px;--ch:${CH}px">${svg}${heads}${cards}${banner}</div>`;
  }

  function mainTreeStatus(t, st) {
    if (st.champion) return { cls: "ok", label: "Terminé · 🏆 " + pname(t, st.champion) };
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
    if (tv.tid !== tid) tv.view = "main";
    tv.tid = tid;
    const S = {
      rotateOn: t0.settings.autoRotate !== false, autoSetting: t0.settings.autoRotate !== false,
      fit: pref("treeFit", true), seen: new Map(), inited: false, drawId: null,
      lastView: null, portrait: null, hinted: false, timer: null,
    };

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
      if (b.dataset.v) { tv.view = b.dataset.v; stopCycle(); update(); }
      else if (b.classList.contains("rot")) { S.rotateOn = !S.rotateOn; stopCycle(); update(); toast(S.rotateOn ? "Rotation automatique activée" : "Rotation automatique en pause"); }
      else if (b.classList.contains("fitbtn")) { S.fit = !S.fit; setPref("treeFit", S.fit); chromeDock(); applyFit(); }
    });

    function stopCycle() { clearTimeout(S.timer); S.timer = null; }
    function startCycle(secs) {
      stopCycle();
      bar.hidden = false;
      bar.innerHTML = `<i style="animation-duration:${secs}s"></i>`;
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
      pill.className = "pill tt-status warn"; pill.innerHTML = "<i></i>Inscriptions";
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

    function applyFit() {
      const tree = fitEl.firstElementChild;
      if (!tree || root.classList.contains("is-empty") || !tree.classList.contains("tree")) return;
      const W = parseFloat(tree.style.width), H = parseFloat(tree.style.height);
      const top = $(".tree-top", root).getBoundingClientRect().bottom + 4;
      const dr = dock.getBoundingClientRect();
      const bottom = (dr.height ? dr.top : window.innerHeight) - 10;
      const vw = stage.clientWidth, vh = stage.clientHeight;
      if (!vw || !vh || !W || !H) return;
      root.classList.toggle("zoom100", !S.fit);
      if (S.fit) {
        stage.classList.remove("scroll");
        const aw = vw - 24, ah = Math.max(60, bottom - top);
        let s = Math.min(aw / W, ah / H);
        s = Math.max(0.08, Math.min(1.6, s));
        fitEl.style.cssText = `left:50%;top:${Math.round(top + ah / 2)}px;transform:translate(-50%,-50%) scale(${s.toFixed(4)})`;
        root.dataset.scale = s.toFixed(3);
        const hint = $(".tree-hint", root);
        if (s < 0.45 && !S.hinted) {
          S.hinted = true; hint.hidden = false;
          setTimeout(() => { hint.hidden = true; }, 4500);
        }
      } else {
        stage.classList.add("scroll");
        $(".tree-hint", root).hidden = true;
        fitEl.style.cssText = `padding:${Math.round(top)}px 16px ${Math.round(vh - bottom + 10)}px`;
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
      st.all.forEach((m) => { if (m.status === "done" && !m.bye && !S.seen.has(m.id)) S.seen.set(m.id, S.inited ? now : 0); });
      S.seen.forEach((v, id) => { const m = st.byId[id]; if (!m || m.status !== "done") S.seen.delete(id); });
      S.inited = true;
      const auto = t.settings.autoRotate !== false;
      if (auto !== S.autoSetting) { S.autoSetting = auto; S.rotateOn = auto; stopCycle(); }
      if (tv.view === "cons" && !st.consolante) tv.view = "main";

      // Arbre
      S.portrait = isPortrait();
      const cons = tv.view === "cons";
      const asNodes = (r) => r.map((m) => ({ kind: "match", match: m }));
      const levels = cons ? st.consolante.rounds.map(asNodes) : [st.leaves].concat(st.main.rounds.map(asNodes));
      const node = el(treeHtml(t, st, levels, cons, !S.portrait, isFresh));
      if (S.lastView !== tv.view) node.classList.add("enter");
      S.lastView = tv.view;
      clear(fitEl);
      fitEl.appendChild(node);

      // Habillage
      $(".tt-name", root).textContent = cons ? "Consolante" : "Tableau principal";
      const s = cons ? consTreeStatus(t, st) : mainTreeStatus(t, st);
      const pill = $(".tt-status", root);
      pill.className = "pill tt-status " + s.cls;
      pill.innerHTML = "<i></i>" + esc(s.label);
      chromeDock(t, st);
      applyFit();

      // Rotation
      if (!(S.rotateOn && st.consolante)) { stopCycle(); bar.hidden = true; bar.innerHTML = ""; }
      else if (!S.timer) startCycle(Math.max(5, parseInt(t.settings.rotateSeconds, 10) || 20));
    }

    function tick() {
      $(".clk", root).textContent = fmtTime(Date.now());
      $(".live-dot", root).classList.toggle("on", isCloud() && cloudStatus() === "connected");
    }

    const onResize = () => { if (isPortrait() !== S.portrait) update(); else applyFit(); };
    window.addEventListener("resize", onResize);
    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(() => applyFit()); ro.observe(stage); }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (live === update) applyFit(); });
    const clockTimer = setInterval(tick, 10000);
    viewCleanup = () => {
      stopCycle();
      clearInterval(clockTimer);
      window.removeEventListener("resize", onResize);
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
  //  Démarrage
  // ============================================================
  function boot() {
    try { Store.load(); } catch (e) { console.error(e); }
    cloudCall("onStatus", () => updateSyncPill());
    updateSyncPill();
    setInterval(updateSyncPill, 2500);

    const pill = document.getElementById("sync-pill");
    if (pill) pill.onclick = () => {
      const m = parseHash().match(/^\/t\/([^/]+)/);
      if (m) navigate("#/t/" + m[1] + "/settings");
      else toast(isCloud() ? "Données partagées en direct ☁︎" : "Mode local — voir Réglages d’un tournoi pour le partage.");
    };

    // Toute mutation (locale ou distante) : titre + arbre en direct.
    Store.onChange(() => { renderNav(); if (live) scheduleLive(); });
    window.addEventListener("hashchange", () => { navCount++; render(); });

    // Changement venant du cloud : re-rendu sauf pendant une saisie.
    cloudCall("onRemoteChange", () => { externalChange(); updateSyncPill(); });

    // Mode local : synchronise les onglets d'un même navigateur (affichage public + saisie).
    window.addEventListener("storage", (e) => {
      if (e.key !== DB_KEY || isCloud()) return;
      try { Store.load(); } catch (err) { console.error(err); return; }
      externalChange();
    });

    // Un rafraîchissement a été différé (saisie en cours) : on l'applique dès que possible.
    setInterval(() => { if (pendingRefresh && !isBusy()) render({ keepScroll: true }); }, 900);

    render();

    Promise.resolve(cloudCall("init")).then((mode) => {
      updateSyncPill();
      if (mode === "cloud" || isCloud()) {
        return Promise.resolve(cloudCall("bootSync")).then(() => {
          externalChange();
          updateSyncPill();
          cloudCall("startPolling");
        });
      }
      return null;
    }).catch((e) => { console.warn("Initialisation cloud :", e); updateSyncPill(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
