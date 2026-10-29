// Moteur de recherche de places : attend l'ouverture de la vente, surveille les tribunes, met au panier
// le meilleur groupe de places conforme et le propose (Garder / Refuser).
const fs = require('fs'), os = require('os'), path = require('path');
const { chromium, CONTEXT_OPTIONS, eventId, poll, openTribune, refreshSection, readSeats, loadCart, emptyCart } = require('./common');
const { handoverCode } = require('./handover');
const { Direct } = require('./direct');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const CONFIG = {
  // Tribunes par ordre de préférence (morceau du nom affiché par le site)
  tribunes: env('TRIBUNES', 'OUEST,AGGLO,REHLKO,EGDC').split(',').map(s => s.trim()).filter(Boolean),
  // Largeur centrale acceptée (0,6 = 60 % central) et hauteur maximale depuis le terrain (0,8 = 80 % des rangs)
  milieu: +env('MILIEU', '0.6'),
  hauteur: +env('HAUTEUR', '0.8'),
  prepMs: +env('PREPARATION_MIN', '3') * 60000,      // démarrage du navigateur avant l'heure d'ouverture
  fastWindowMs: +env('FENETRE_RAPIDE_MIN', '5') * 60000,  // durée du rythme rapide après l'ouverture (et après un refus)
  fastMs: +env('RYTHME_RAPIDE_MS', '500'),          // pause entre deux tours en rythme rapide
  slowMs: +env('VEILLE_S', '10') * 1000,            // pause quand aucune place ne convient, hors rythme rapide
  reloadMs: 10 * 60000,                             // rechargement complet des plans de temps en temps
  cartMs: 15 * 60000,                               // durée de validité d'un panier
  // Méthode « requêtes » en parallèle de la méthode des pages (0 pour la désactiver)
  direct: env('METHODE_REQUETES', '1') !== '0',
  // Page de la billetterie listant les matchs (un bouton « Réserver » par match)
  listUrl: env('BILLETTERIE', 'https://web.digitick.com/index-css5-choletbasketmobile-pg1.html'),
};

// La billetterie existe aussi sous web.digitick.com (mêmes identifiants de match). Les achats se font toujours sur
// billetterie.seetickets.fr : panier et favori de récupération y sont établis et testés.
const toSeetickets = u => u.replace(/^https?:\/\/web\.digitick\.com\//, 'https://billetterie.seetickets.fr/');

const MONTHS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const norm = t => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Date du match : « 22 octobre 2026 », « 1er décembre », « 22/10/2026 » ou « 22/10 » (sans année : prochaine occurrence)
function parseMatchDate(text, now = new Date()) {
  const s = norm(text);
  let d, m, y;
  let r = s.match(/^(\d{1,2})(?:er)?\s+([a-z]{3,})\.?(?:\s+(\d{4}))?$/);
  if (r) { d = +r[1]; m = MONTHS.findIndex(x => x.startsWith(r[2].slice(0, 4))) + 1; y = r[3] && +r[3]; }
  else if ((r = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/))) { d = +r[1]; m = +r[2]; y = r[3] && +r[3]; }
  if (!d || !m || m > 12 || d > 31) return null;
  if (!y) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(now).split('-').map(Number);
    y = parts[0];
    if (m < parts[1] || (m === parts[1] && d < parts[2])) y++;
  }
  return { d, m, y, label: `${d} ${MONTHS_FR[m - 1]} ${y}` };
}

// Liens « Réserver » de la page de la billetterie, avec le texte du bloc de chaque match : [{ href, text }].
// Page récupérée par une simple requête (≈ 10 fois plus rapide qu'un chargement complet), analysée dans le navigateur.
// Bloc du match = plus petit parent du bouton qui contient une année : on ne prend pas le bouton d'un match voisin.
async function listMatchLinks(page, listUrl) {
  const html = await (await page.request.get(listUrl, { timeout: 15000 })).text();
  return page.evaluate(([html, base]) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [], links = doc.querySelectorAll('a[href]');
    for (let i = 0; i < links.length; i++) {
      const a = links[i];
      if (!/r[ée]server/i.test(a.textContent)) continue;
      let blk = a;
      while (blk.parentElement && !/\b20\d\d\b/.test(blk.textContent)) blk = blk.parentElement;
      out.push({ href: new URL(a.getAttribute('href'), base).href, text: blk.textContent.replace(/\s+/g, ' ').trim() });
    }
    return out;
  }, [html, listUrl]);
}
const dateRegex = date => new RegExp(`(^|[^0-9])${date.d}(er)? ${MONTHS[date.m - 1]} ${date.y}`);

// Lien « Réserver » du match à cette date, ou null s'il n'y est pas (encore)
async function findMatchLink(page, listUrl, date) {
  const rx = dateRegex(date);
  return (await listMatchLinks(page, listUrl)).find(l => rx.test(norm(l.text))) || null;
}

// Nom court du match d'après le texte de son bloc : « DIJON Samedi 7 Novembre 2026 - 18h00 »
const matchLabel = text => (text.match(/^(.*?\d{1,2}h\d{2})/) || [0, text.slice(0, 60)])[1];

// Catégories acceptées : bancs uniquement, jamais de VIP. Niveaux 3/4 d'abord, puis les autres bancs du plus cher
// au moins cher. Renvoie { idGroupe: rang de préférence }.
function categoryTiers(groups) {
  const ok = Object.entries(groups).filter(([, i]) => /BANCS/i.test(i.name) && !/VIP/i.test(i.name));
  const tiers = {};
  const others = ok.filter(([, i]) => !/NIVEAU [34] BANCS/i.test(i.name)).sort((a, b) => b[1].cents - a[1].cents);
  for (const [g, i] of ok) if (/NIVEAU [34] BANCS/i.test(i.name)) tiers[g] = 0;
  others.forEach(([g], k) => { tiers[g] = 1 + k; });
  return tiers;
}

// Géométrie de la tribune : centre et demi-largeur, position verticale des rangs (0 = côté terrain, 1 = tout en haut)
function geometry(seats) {
  const xs = seats.map(s => s.x), ys = seats.map(s => s.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const a = seats.find(s => s.rang === 'A');
  const courtBottom = !a || a.y > (minY + maxY) / 2;  // le rang A est le plus proche du terrain
  const span = (maxY - minY) || 1;
  return {
    minX, maxX, minY, maxY, courtBottom,
    cx: (minX + maxX) / 2, half: ((maxX - minX) / 2) || 1,
    height: y => (courtBottom ? maxY - y : y - minY) / span,
  };
}

// Groupes de `places` sièges contigus conformes aux règles, du meilleur au moins bon :
// catégorie, puis rang le plus proche du terrain, puis tirage au sort (pas de course au plein centre)
function candidates({ seats, groups }, places, refused) {
  if (!seats.length) return [];
  const geo = geometry(seats);
  const tiers = categoryTiers(groups);
  const inZone = s => Math.abs(s.x - geo.cx) / geo.half <= CONFIG.milieu && geo.height(s.y) <= CONFIG.hauteur + 1e-9;
  const usable = seats.filter(s => s.free && s.g && tiers[s.g] !== undefined && !refused.has(s.id) && inZone(s));
  const byPos = {};
  for (const s of usable) byPos[s.y + ':' + s.x] = s;
  const out = [];
  for (const s of usable) {
    const grp = [s];
    for (let k = 1; k < places; k++) {
      const n = byPos[s.y + ':' + (s.x + k)];
      if (!n || n.g !== s.g || n.rang !== s.rang) break;
      grp.push(n);
    }
    if (grp.length !== places) continue;
    out.push({ seats: grp, tier: tiers[s.g], h: geo.height(s.y), rnd: Math.random(), cat: groups[s.g].name, cents: groups[s.g].cents });
  }
  return out.sort((a, b) => a.tier - b.tier || a.h - b.h || a.rnd - b.rnd);
}

// Plan de la tribune dessiné d'après les données des sièges : places réservées en rouge, libres en vert,
// zone acceptée en pointillés, terrain du côté du rang A
async function seatMapImage(browser, { seats }, mine, title) {
  const geo = geometry(seats);
  const ids = new Set(mine.map(s => s.id));
  const C = 14, L = 34, T = 46, B = 44;
  const W = (geo.maxX - geo.minX + 1) * C + 2 * L, H = T + (geo.maxY - geo.minY + 1) * C + B;
  const X = x => L + (x - geo.minX) * C + C / 2, Y = y => T + (y - geo.minY) * C + C / 2;
  const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const rows = {};
  for (const s of seats) rows[s.rang] = s.y;
  // Zone acceptée : largeur centrale, et rangs depuis le terrain jusqu'à la hauteur maximale
  const zx0 = X(geo.cx - CONFIG.milieu * geo.half) - C / 2, zx1 = X(geo.cx + CONFIG.milieu * geo.half) + C / 2;
  const span = geo.maxY - geo.minY;
  const yLimit = geo.courtBottom ? geo.maxY - CONFIG.hauteur * span : geo.minY + CONFIG.hauteur * span;
  const zy0 = geo.courtBottom ? Y(Math.ceil(yLimit)) - C / 2 : Y(geo.minY) - C / 2;
  const zy1 = geo.courtBottom ? Y(geo.maxY) + C / 2 : Y(Math.floor(yLimit)) + C / 2;
  const courtY = geo.courtBottom ? Y(geo.maxY) + C : T - 24;
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Arial, sans-serif">`,
    `<rect width="100%" height="100%" fill="#fff"/>`,
    `<text x="${W / 2}" y="20" text-anchor="middle" font-size="15" font-weight="bold">${esc(title)}</text>`,
    `<text x="${W / 2}" y="37" text-anchor="middle" font-size="11" fill="#555"><tspan fill="#e3001b">●</tspan> réservé   <tspan fill="#8fd18f">●</tspan> libre   <tspan fill="#bbb">●</tspan> indisponible   ┅ zone acceptée</text>`,
    `<rect x="${zx0}" y="${zy0}" width="${zx1 - zx0}" height="${zy1 - zy0}" fill="#fff8e0" stroke="#c90" stroke-dasharray="5 4"/>`,
    ...Object.entries(rows).map(([r, y]) => `<text x="${L - 6}" y="${Y(y) + 4}" text-anchor="end" font-size="10" fill="#666">${esc(r)}</text><text x="${W - L + 6}" y="${Y(y) + 4}" font-size="10" fill="#666">${esc(r)}</text>`),
    ...seats.filter(s => !ids.has(s.id)).map(s => `<circle cx="${X(s.x)}" cy="${Y(s.y)}" r="4.5" fill="${s.free ? '#8fd18f' : '#dcdcdc'}"/>`),
    ...seats.filter(s => ids.has(s.id)).map(s => `<circle cx="${X(s.x)}" cy="${Y(s.y)}" r="6.5" fill="#e3001b" stroke="#000" stroke-width="1.5"/>`),
    `<rect x="${L}" y="${courtY}" width="${W - 2 * L}" height="20" fill="#c8102e"/>`,
    `<text x="${W / 2}" y="${courtY + 14}" text-anchor="middle" font-size="12" fill="#fff" font-weight="bold">TERRAIN</text>`,
    `</svg>`].join('\n');
  const page = await browser.newPage();
  try {
    await page.setContent(`<body style="margin:0">${svg}</body>`);
    const file = path.join(os.tmpdir(), `places-${Date.now()}.png`);
    await page.locator('svg').screenshot({ path: file });
    return file;
  } finally { await page.close(); }
}

// Après un ajout, la version mobile déplie le panier en plein écran par-dessus le plan
const CART_PANEL_OPEN = `(()=>{const e=document.querySelector('#compPanier1 .dataContentComposants');if(!e)return false;const r=e.getBoundingClientRect();
  return getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden'&&r.height>300&&r.bottom>0&&r.top<innerHeight})()`;

// Sélectionne le groupe sur le plan, choisit le plein tarif et valide ; renvoie la réponse « add » du serveur
// t (facultatif) reçoit la durée cumulée de chaque étape, en ms : sélection, tarifs, serveur
async function tryAdd(p, cand, places, dryRun, t = {}) {
  const T = Date.now(), lap = n => { t[n] = Date.now() - T; };
  // scrollerPanier() bascule l'affichage : appelé seulement si le panier est déplié
  if (await p.evaluate(CART_PANEL_OPEN)) { await p.evaluate('compPanier1.scrollerPanier()'); await poll(p, `!${CART_PANEL_OPEN}`, 2000).catch(() => {}); }
  await p.evaluate(`(()=>{const rs=Map.instances['mapRoom_default-2'].plugins['MapRoomSection']; rs.select(${JSON.stringify(cand.seats.map(s => s.cellId))}, true);})()`);
  await poll(p, `document.querySelector('#validateButton').textContent.includes('(${places})')`, 2000).catch(() => {});
  if (!(await p.locator('#validateButton').innerText()).includes(`(${places})`)) return null;
  lap('sélection');
  await p.locator('#validateButton').click({ timeout: 5000 });
  await p.locator('#PricesSelector input.addToCart').waitFor({ timeout: 10000 });
  let tarifs = [];
  for (let i = 0; i < 60 && tarifs.length < places; i++) {
    if (i) await p.waitForTimeout(50);
    tarifs = JSON.parse(await p.evaluate(`(()=>{const r=[]; document.querySelectorAll('#jqibox select').forEach(s=>{const o=Array.from(s.options).find(o=>/PLEIN TARIF/.test(o.text)); if(o) s.value=o.value; r.push(s.options[s.selectedIndex].text);}); return JSON.stringify(r);})()`));
  }
  lap('tarifs');
  if (tarifs.length !== places || !tarifs.every(x => /PLEIN TARIF/.test(x)) || dryRun) {
    await p.locator('#PricesSelector input.cancel').click({ timeout: 2000 }).catch(() => {});
    return dryRun && tarifs.length === places ? { dry: true, tarifs } : null;
  }
  const respP = p.waitForResponse(r => (r.request().postData() || '').includes('action=add'), { timeout: 20000 }).catch(() => null);
  await p.locator('#PricesSelector input.addToCart').click({ timeout: 5000 });
  const resp = await respP;
  lap('serveur');
  try { return resp ? JSON.parse(await resp.text()) : null; } catch { return null; }
}

const fmtSecs = ms => (ms / 1000).toFixed(1).replace('.', ',');
const short = name => String(name || '').replace(/^TRIBUNE /i, '');
// Durées cumulées → « page 6,1 · grille 2,7 · … » (durée de chaque étape)
const steps = laps => { let prev = 0; return Object.entries(laps).map(([k, v]) => { const d = v - prev; prev = v; return `${k} ${fmtSecs(d)}`; }).join(' · '); };

class Hunt {
  // events : status(texte), info(texte), proposal(proposition) → Promise<'keep'|'refuse'|'expired'|'cancel'>
  // url : page des places du match ; ou date : { d, m, y, label } pour trouver le match sur la billetterie à l'ouverture
  constructor({ url, date, openAt, places = 2, dryRun = false, events }) {
    this.url = url || null; this.ev = url ? eventId(url) : null; this.date = date;
    this.openAt = openAt; this.places = places; this.dryRun = dryRun;
    this.events = events; this.cancelled = false; this.refused = new Set();
    this.state = { phase: 'attente', detail: '' };
    this.chrono = { tribunes: {}, reads: 0 };
    this.direct = null; this.directState = 'off'; this.pagesOff = false;
  }

  cancel() { this.cancelled = true; }

  // Chronologie pour le débogage : temps de chaque étape, envoyé avec la proposition et écrit dans le journal
  chronoText(added, add) {
    const c = this.chrono, ref = Math.max(this.openAt, c.ready || 0);
    const rel = t => `+${fmtSecs(t - ref)} s`;
    const lines = [`⏱ Chronologie (depuis ${this.openAt >= (c.ready || 0) ? "l'heure d'ouverture" : 'le démarrage du navigateur'})`];
    if (c.found) lines.push(`• Bouton « Réserver » détecté : ${rel(c.found)} (${c.reads} lecture(s) de la page, dernière en ${fmtSecs(c.lastRead)} s)`);
    if (c.direct && c.direct.end) lines.push(`• Méthode requêtes prête : ${rel(c.direct.end)} (${fmtSecs(c.direct.end - c.direct.start)} s : ${steps(c.direct.laps)})`);
    for (const k of CONFIG.tribunes) {
      const t = c.tribunes[k];
      if (t && t.end && t.end <= added) lines.push(`• Pages : ${short(this.names[k])} prête : ${rel(t.end)} (${fmtSecs(t.end - t.start)} s : ${steps(t.laps)})`);
    }
    if (c.searchStart) lines.push(`• Recherche démarrée : ${rel(c.searchStart)}`);
    lines.push(`• Tour gagnant (${c.round.method}) : lecture des places ${fmtSecs(c.round.refresh)} s, choix ${fmtSecs(c.round.choice)} s`);
    lines.push(`• Ajout au panier : ${fmtSecs(add.serveur || 0)} s (${steps(add)})`);
    lines.push(`• Places au panier : ${rel(added)}${c.found ? ` (${fmtSecs(added - c.found)} s après le bouton)` : ''}`);
    return lines.join('\n');
  }

  log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

  setState(phase, detail = '') { this.state = { phase, detail, at: Date.now() }; }

  // Pause interrompue dès l'annulation
  async sleep(ms) {
    const end = Date.now() + ms;
    while (!this.cancelled && Date.now() < end) await new Promise(r => setTimeout(r, Math.min(250, end - Date.now())));
  }

  async run() {
    try { return await this.loop(); } finally { if (this.browser) await this.browser.close().catch(() => {}); }
  }

  async startBrowser() {
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = await chromium.launch();
    this.ctx = await this.browser.newContext(CONTEXT_OPTIONS);
    this.cartPage = await this.ctx.newPage();
    // Pas de connexion au compte : une session anonyme suffit pour mettre au panier, et le panier est conservé
    // quand on se connecte sur le téléphone au moment de payer. Page du site ouverte d'avance pour le panier.
    await loadCart(this.cartPage, this.url || toSeetickets(CONFIG.listUrl)).catch(e => this.log('page panier :', e.message.split('\n')[0]));
    if (!this.chrono.ready) this.chrono.ready = Date.now();
    this.log('Navigateur prêt');
    this.pages = {}; this.opened = {};
    // Les requêtes partagent les cookies du contexte : même session, même panier que les pages
    const params = this.direct && this.direct.params;
    this.direct = new Direct(this.ctx);
    if (params) this.direct.params = params;
  }

  async open(key) {
    if (!this.pages[key]) this.pages[key] = await this.ctx.newPage();
    const first = !(this.chrono.tribunes[key] && this.chrono.tribunes[key].end);
    const c = { start: Date.now(), laps: {} };
    this.names[key] = await openTribune(this.pages[key], this.url, key, c.laps);
    this.opened[key] = Date.now();
    if (first) { c.end = this.opened[key]; this.chrono.tribunes[key] = c; }
    if (!this.ev) this.ev = eventId(this.pages[key].url());
  }

  // Préparation, avant l'ouverture : paramètres de la salle pour les requêtes, lus sur un autre match de la billetterie,
  // et cache du navigateur préchauffé sur ce match pour la méthode des pages (≈ 3 s gagnées à l'ouverture, mesuré)
  prepare(scan) {
    const other = (async () => {
      if (this.url) return null;
      const rx = dateRegex(this.date);
      const l = (await listMatchLinks(scan, CONFIG.listUrl)).find(x => !rx.test(norm(x.text)));
      return l && toSeetickets(l.href);
    })();
    if (CONFIG.direct) {
      this.paramsP = other.then(u => this.direct.loadParams(u || this.url))
        .then(() => this.log('Paramètres des requêtes prêts'), e => this.log('paramètres des requêtes :', e.message.split('\n')[0]));
    }
    other.then(async u => {
      if (!u) return;
      const w = await this.ctx.newPage();
      const T = Date.now();
      try { await openTribune(w, u, CONFIG.tribunes[0]); this.log(`Cache préchauffé sur un autre match (${fmtSecs(Date.now() - T)} s)`); } finally { await w.close(); }
    }).catch(e => this.log('préchauffage :', e.message.split('\n')[0]));
  }

  // Attend le bouton « Réserver » du match sur la page de la billetterie
  async findMatch(scan) {
    this.setState('ouverture', `recherche du match du ${this.date.label} sur la billetterie`);
    let announced = false;
    while (!this.cancelled) {
      try {
        const tr = Date.now();
        const link = await findMatchLink(scan, CONFIG.listUrl, this.date);
        this.chrono.reads++; this.chrono.lastRead = Date.now() - tr;
        if (link) {
          this.chrono.found = Date.now();
          // Les onglets des tribunes suivent eux-mêmes le lien (redirection vers la page des places) ;
          // l'identifiant du match est lu dans la redirection (requêtes) ou sur la page d'arrivée (pages)
          this.url = toSeetickets(link.href); this.matchLabel = matchLabel(link.text);
          this.log('Match trouvé :', this.matchLabel, this.url);
          this.events.info(`🎫 Billetterie ouverte : ${this.matchLabel}. Je cherche des places.`);
          return true;
        }
      } catch (e) { this.log('billetterie :', e.message.split('\n')[0]); }
      if (!announced && Date.now() >= this.openAt) {
        this.events.info(`⏳ Heure d'ouverture atteinte : pas encore de bouton « Réserver » pour le ${this.date.label}. Je regarde toutes les ${CONFIG.fastMs} ms.`);
        announced = true;
      }
      await this.sleep(Date.now() < this.openAt ? 3000 : CONFIG.fastMs);
    }
    return false;
  }

  // Méthode « requêtes » : identifiant du match, tribunes, première lecture des 4 tribunes (validation)
  async startDirect(active) {
    this.directState = 'starting';
    const c = this.chrono.direct = { start: Date.now(), laps: {} };
    const T = Date.now(), lap = n => { c.laps[n] = Date.now() - T; };
    try {
      if (!this.direct.params && this.paramsP) await this.paramsP;
      if (!this.direct.params) { await this.direct.loadParams(this.url); lap('paramètres'); }
      await this.direct.resolve(this.url); lap('match');
      if (!this.ev) this.ev = this.direct.show;
      const names = await this.direct.sections(); lap('tribunes');
      this.directIds = {};
      for (const k of active) {
        const id = Object.keys(names).find(i => names[i].toUpperCase().includes(k.toUpperCase()));
        if (id) { this.directIds[k] = id; this.names[k] = this.names[k] || names[id]; }
      }
      if (!this.directIds[active[0]] && !Object.keys(this.directIds).length) throw new Error('aucune tribune trouvée');
      const datas = await Promise.all(Object.values(this.directIds).map(id => this.direct.read(id))); lap('lecture');
      if (!datas.some(d => d.seats.length)) throw new Error('plans vides');
      c.end = Date.now();
      this.directState = 'ok';
      this.log(`Méthode requêtes prête (${fmtSecs(c.end - c.start)} s : ${steps(c.laps)})`);
    } catch (e) { this.failDirect(e.message.split('\n')[0]); }
  }

  failDirect(reason) {
    if (this.directState === 'failed') return;
    this.directState = 'failed';
    this.log('Méthode requêtes en échec :', reason);
    this.events.info(`⚠️ Méthode rapide (requêtes) en échec : ${reason}. Je continue avec la méthode des pages.`);
    if (this.pagesOff) { this.pagesOff = false; this.log('Méthode des pages relancée'); }
  }

  // La méthode requêtes fonctionne : la méthode des pages (secours) est arrêtée
  stopPages(reason) {
    if (this.pagesOff) return;
    this.pagesOff = true;
    this.log(`Méthode requêtes validée (${reason}) : arrêt de la méthode des pages`);
    for (const k of Object.keys(this.pages)) this.pages[k].close().catch(() => {});
    this.pages = {}; this.opened = {};
  }

  // Comparaison des places libres vues par les deux méthodes (validation de la méthode requêtes)
  crossCheck(pageData, directData) {
    const res = [];
    for (const [k, pd] of Object.entries(pageData)) {
      const dd = directData[k];
      if (!dd) continue;
      const a = new Set(pd.seats.filter(x => x.free).map(x => Number(x.id))), b = new Set(dd.seats.filter(x => x.free).map(x => x.id));
      let diff = 0;
      for (const x of a) if (!b.has(x)) diff++;
      for (const x of b) if (!a.has(x)) diff++;
      res.push({ k, ok: diff <= Math.max(3, 0.05 * Math.max(a.size, b.size)), diff, a: a.size, b: b.size });
    }
    if (!res.length) return;
    this.log('Vérification requêtes/pages :', res.map(r => `${short(this.names[r.k])} ${r.b}/${r.a} libres (écart ${r.diff})`).join(', '));
    if (res.every(r => r.ok)) {
      if (++this.checks >= 3) this.stopPages('3 vérifications concordantes');
    } else if (++this.mismatches >= 2) this.failDirect('places libres différentes de celles du site');
  }

  async emptyCart() {
    if (this.directState === 'ok') { try { return await this.direct.empty(); } catch (e) { this.log('vidage par requête :', e.message.split('\n')[0]); } }
    return emptyCart(this.cartPage, this.url);
  }

  async loop() {
    const { events } = this;
    // 1. Attente jusqu'à peu avant l'ouverture
    while (!this.cancelled && Date.now() < this.openAt - CONFIG.prepMs) {
      this.setState('attente');
      await this.sleep(Math.min(30000, this.openAt - CONFIG.prepMs - Date.now()));
    }
    if (this.cancelled) return 'cancelled';
    const tStart = Date.now();

    // 2. Démarrage du navigateur et préparation, puis recherche du match sur la billetterie si son lien n'est pas connu
    this.setState('préparation', 'démarrage');
    await this.startBrowser();
    const scan = await this.ctx.newPage();
    this.prepare(scan);
    if (!this.url && !(await this.findMatch(scan))) return 'cancelled';

    // 3. Surveillance avec deux méthodes en parallèle, une seule mise au panier à la fois (boucle unique) :
    // - requêtes (≈ 1 s pour être prête), utilisée dès qu'elle est prête ;
    // - pages (≈ 8 à 10 s), en secours : plans ouverts en arrière-plan ; la recherche y démarre dès que la tribune
    //   préférée est prête, une tribune moins bien classée n'étant utilisée que si les mieux classées sont prêtes
    //   (ou toujours en échec après PENDING_MS). Arrêtée quand la méthode requêtes a fait ses preuves.
    const PENDING_MS = 20000;
    this.names = {};
    let active = [...CONFIG.tribunes];
    this.directState = 'off'; this.pagesOff = false; this.checks = 0; this.mismatches = 0;
    if (CONFIG.direct) this.startDirect(active);
    const opening = {}, pendingSince = {};
    const startOpen = k => {
      if (opening[k]) return;
      pendingSince[k] = pendingSince[k] || Date.now();
      opening[k] = this.open(k).then(() => {
        delete opening[k]; delete pendingSince[k];
        const c = this.chrono.tribunes[k];
        this.log(`Plan ouvert : ${this.names[k]}`, c && c.end && c.end === this.opened[k] ? `(${fmtSecs(c.end - c.start)} s : ${steps(c.laps)})` : '');
      }, e => {
        delete opening[k]; this.opened[k] = 0;
        if (this.pagesOff) return;
        // Tribune que ce match ne propose pas (la liste des tribunes est affichée, sans elle)
        if (/absente/.test(e.message)) { active = active.filter(x => x !== k); events.info(`ℹ️ Tribune ${k} absente pour ce match.`); }
      });
    };
    let fastUntil = 0, announced = false, check = null;
    let round = 0, errors = 0, idleAnnounced = false, lastStatus = '';
    while (!this.cancelled) {
      round++;
      const t0 = Date.now();
      try {
        // Méthode des pages : plans manquants ou anciens (ré)ouverts en arrière-plan, sans attendre
        if (!this.pagesOff) for (const k of active) if (!opening[k] && (!this.opened[k] || Date.now() - this.opened[k] > CONFIG.reloadMs)) startOpen(k);
        const ready = this.pagesOff ? [] : active.filter(k => this.opened[k] && !opening[k]);
        const direct = this.directState === 'ok';
        if (!direct && !ready.length) {
          // Aucune méthode prête : requêtes en cours de démarrage, ou plans en cours d'ouverture
          this.setState('ouverture', 'attente de la mise en vente');
          if (!announced && Date.now() >= this.openAt + 5000 && this.directState !== 'starting' && !Object.keys(opening).length) {
            events.info('⏳ La vente n\'est pas encore visible : je réessaie en continu.');
            announced = true;
          }
          await this.sleep(this.directState === 'starting' ? 30 : Object.keys(opening).length ? 100 : 1000);
          continue;
        }
        if (!fastUntil) fastUntil = Math.max(Date.now(), this.openAt) + CONFIG.fastWindowMs;
        const method = direct ? 'requêtes' : 'pages';
        const tr = Date.now();
        const datas = {};
        let waiting = false;
        if (direct) {
          // Vérification croisée du tour précédent (pages), tant que la méthode requêtes n'est pas validée
          if (check) { const c = check; check = null; await c; }
          const keys = active.filter(k => this.directIds[k]);
          let res;
          try { res = await Promise.all(keys.map(k => this.direct.read(this.directIds[k]))); }
          catch (e) { this.failDirect(e.message.split('\n')[0]); continue; }
          keys.forEach((k, i) => { datas[k] = res[i]; });
          if (!this.pagesOff && ready.length) {
            // Lecture des pages en parallèle, comparée au tour suivant : n'attend pas avant l'ajout
            check = Promise.all(ready.map(async k => { await refreshSection(this.pages[k]); return [k, await readSeats(this.pages[k])]; }))
              .then(pd => this.crossCheck(Object.fromEntries(pd), datas), e => this.log('vérification :', e.message.split('\n')[0]));
          }
        } else {
          await Promise.all(ready.map(k => refreshSection(this.pages[k])));
          for (const k of active) {
            if (!ready.includes(k)) {
              // Tribune mieux classée pas encore prête : on l'attend plutôt que de prendre moins bien
              // (sans date d'attente = ouverte pendant ce tour, prête au suivant)
              if (!Object.keys(datas).length && (pendingSince[k] === undefined || Date.now() - pendingSince[k] < PENDING_MS)) { waiting = true; break; }
              continue;
            }
            datas[k] = await readSeats(this.pages[k]);
          }
        }
        const tc = Date.now();
        if (!this.chrono.searchStart) this.chrono.searchStart = tr;
        let best = null; const status = [];
        for (const k of active) {
          if (!datas[k]) continue;
          const cands = candidates(datas[k], this.places, this.refused);
          status.push(`${short(this.names[k])} : ${datas[k].seats.filter(x => x.free).length} libres, ${cands.length} conformes`);
          if (!best && cands.length) best = { ...cands[0], key: k, data: datas[k] };
        }
        this.chrono.round = { refresh: tc - tr, choice: Date.now() - tc, method };
        errors = 0;
        if (status.join(' | ') !== lastStatus) { lastStatus = status.join(' | '); this.log(`#${round} [${method}] ${lastStatus} (${Date.now() - t0} ms)`); }
        if (!best) {
          const fast = waiting || Date.now() < fastUntil;
          this.setState('recherche', waiting ? 'ouverture des tribunes' : `aucune place conforme, ${fast ? 'rythme rapide' : `nouvel essai toutes les ${CONFIG.slowMs / 1000} s`}`);
          if (!idleAnnounced && !fast) { events.info(`🔎 Aucune place conforme pour l'instant. Je surveille toutes les ${CONFIG.slowMs / 1000} s et je te préviens dès que des places se libèrent.`); idleAnnounced = true; }
          await this.sleep(waiting ? 100 : fast ? CONFIG.fastMs : CONFIG.slowMs);
          continue;
        }
        const desc = `${this.names[best.key]} - ${best.cat} - rang ${best.seats[0].rang} places ${best.seats.map(x => x.num).join(', ')}`;
        this.setState('recherche', `tentative : ${desc}`);
        this.log(`Tentative [${method}] :`, desc);
        const addLaps = {};
        let res;
        if (direct) {
          if (this.dryRun) { this.log(`Dry-run : ajout par requête non envoyé (essai en ${fmtSecs(Date.now() - t0)} s)`); this.log(this.chronoText(Date.now(), addLaps)); return 'dry'; }
          const ta = Date.now();
          try { res = await this.direct.add(best.seats, (best.data.groups[best.seats[0].g] || {}).priceId); }
          catch (e) { this.failDirect(e.message.split('\n')[0]); continue; }
          addLaps.serveur = Date.now() - ta;
          if (!res || !res.cart2) { this.failDirect('réponse d\'ajout inattendue'); await this.emptyCart().catch(() => {}); continue; }
        } else {
          res = await tryAdd(this.pages[best.key], best, this.places, this.dryRun, addLaps);
          if (res && res.dry) {
            this.log(`Dry-run : arrêt avant validation (essai en ${fmtSecs(Date.now() - t0)} s)`, res.tarifs.join(' | '));
            this.log(this.chronoText(Date.now(), addLaps));
            return 'dry';
          }
        }
        const ok = res && res.cart2 && res.cart2.success && res.cart2.success[this.ev];
        this.log(`Réponse ajout [${method}] :`, ok ? `${ok.nbPlaces} place(s) acceptée(s)` : 'refus / pas de réponse', `(${fmtSecs(Date.now() - t0)} s)`);
        if (ok && ok.nbPlaces === this.places) {
          if (direct) this.stopPages('ajout réussi');
          idleAnnounced = false;
          const added = Date.now();
          const since = Math.round((added - Math.max(tStart, this.openAt)) / 1000);
          const timing = `⏱ Réservé en ${fmtSecs(added - t0)} s (détection → confirmation)` +
            (this.openAt <= added ? `, ${Math.floor(since / 60)} min ${since % 60} s après l'ouverture` : '');
          const price = best.cents ? ` - ${((best.cents * this.places) / 100).toFixed(2).replace('.', ',')} €` : '';
          const chrono = this.chronoText(added, addLaps);
          this.log(chrono);
          this.setState('proposition', desc);
          const decision = await events.proposal({
            desc: desc + price, timing, chrono, seats: best.seats, expiresAt: added + CONFIG.cartMs,
            code: await handoverCode(this.ctx),
            // Image générée seulement quand l'appelant la demande, sans bloquer la proposition
            // État du plan juste avant l'ajout (juste après, le plan recharge ses statuts et paraît tout libre)
            image: () => seatMapImage(this.browser, best.data, best.seats, desc),
          });
          if (decision === 'keep') { this.setState('terminé', desc); return 'kept'; }
          if (decision === 'cancel') return 'cancelled';
          if (decision === 'refuse') best.seats.forEach(x => this.refused.add(x.id));
          const left = await this.emptyCart();
          if (left) this.log(`Panier non vidé (${left} place(s))`);
          fastUntil = Date.now() + CONFIG.fastWindowMs;
          continue;
        }
        // Réponse sans succès ni refus explicite (direct) : méthode non fiable
        if (direct && !ok && !(res.cart2 && res.cart2.error)) this.failDirect('réponse d\'ajout sans succès ni refus');
        // Panier partiel ou réponse illisible (l'ajout a pu passer) : on vide le panier.
        // Refus explicite (places prises entre-temps) : le tour suivant efface la sélection, on enchaîne.
        if (ok || !res) await this.emptyCart();
      } catch (e) {
        errors++;
        this.log(`#${round} erreur : ${e.message.split('\n')[0]}`);
        if (errors >= 5) {
          this.log('Erreurs répétées : redémarrage du navigateur');
          await Promise.allSettled(Object.values(opening));
          await this.startBrowser().catch(err => this.log('redémarrage :', err.message.split('\n')[0]));
          if (this.directState === 'ok' && CONFIG.direct) this.startDirect(active);
          errors = 0;
        } else active.forEach(k => { if (!opening[k]) this.opened[k] = 0; });  // plans rouverts au tour suivant
        await this.sleep(1000);
      }
    }
    return 'cancelled';
  }
}

// Heure de Paris → Date, sans dépendance (gère l'heure d'été)
function parisOffsetMs(ts) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ts));
  const g = t => +parts.find(p => p.type === t).value;
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ts / 1000) * 1000;
}
function parisTime(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - parisOffsetMs(guess);
  t = guess - parisOffsetMs(t);
  return new Date(t);
}
// « maintenant », « HH:MM », « JJ/MM HH:MM » ou « JJ/MM/AAAA HH:MM » (heure de Paris) ; sans année : prochaine occurrence
function parseOpening(text, now = new Date()) {
  const s = text.trim().toLowerCase();
  if (s === 'maintenant' || s === 'now') return now;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(\d{1,2})[:h](\d{2})$/);
  const yearNow = +new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', year: 'numeric' }).format(now);
  if (m) {
    let d = parisTime(m[3] ? +m[3] : yearNow, +m[2], +m[1], +m[4], +m[5]);
    if (!m[3] && d < now - 86400000) d = parisTime(yearNow + 1, +m[2], +m[1], +m[4], +m[5]);
    return d;
  }
  m = s.match(/^(\d{1,2})[:h](\d{2})$/);
  if (m) {
    const today = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).split('/');
    let d = parisTime(+today[2], +today[1], +today[0], +m[1], +m[2]);
    if (d < now - 3600000) d = new Date(d.getTime() + 86400000);
    return d;
  }
  return null;
}
const fmtParis = d => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(d);

module.exports = { Hunt, CONFIG, candidates, categoryTiers, geometry, seatMapImage, tryAdd, parseOpening, parseMatchDate, findMatchLink, listMatchLinks, fmtParis };
