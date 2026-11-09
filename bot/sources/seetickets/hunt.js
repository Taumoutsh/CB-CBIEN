// Moteur Seetickets (Cholet Basket) : attend l'ouverture de la vente, surveille les tribunes, met au panier le meilleur
// groupe de places conforme et le propose (Garder / Refuser). Deux méthodes en parallèle : requêtes (direct.js, rapide)
// et pages du site (pages.js, secours).
const { chromium, CONTEXT_OPTIONS, eventId, poll, openTribune, refreshSection, readSeats, loadCart, emptyCart } = require('./pages');
const { pickupLink } = require('./handover');
const { Direct } = require('./direct');
const { BaseHunt, TIMING, env, fmtSecs, steps } = require('../../lib/engine');
const { MONTHS, norm, parseMatchDate, words } = require('../../lib/dates');
const { geometry, inZone, seatMapImage } = require('../../lib/seats');

const CONFIG = {
  reloadMs: 10 * 60000,   // rechargement complet des plans de temps en temps
  cartMs: 15 * 60000,     // durée de validité d'un panier
  // Méthode « requêtes » en parallèle de la méthode des pages (0 pour la désactiver)
  direct: env('METHODE_REQUETES', '1') !== '0',
};

// La billetterie existe aussi sous web.digitick.com (mêmes identifiants de match). Les achats se font toujours sur
// billetterie.seetickets.fr : panier et lien de reprise y sont établis et testés.
const toSeetickets = u => u.replace(/^https?:\/\/web\.digitick\.com\//, 'https://billetterie.seetickets.fr/');

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
// Début du bloc d'un match, avant le jour de la semaine : le nom de l'adversaire (« DIJON Samedi 7 Novembre… » → « dijon »).
// Le reste du bloc (salle, adresse) n'est pas comparé.
const opponentPart = text => norm(text).split(/ (?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche) /)[0];

// Reconnaît le bloc du match visé : par sa date ({ date }) ou par le nom de l'adversaire ({ team }), mot à mot,
// sans accents ni majuscules ni tirets (« Saint Quentin » ↔ « SAINT-QUENTIN », « Chalon » ↔ « CHALON SUR SAONE »)
function matcher({ date, team }) {
  if (date) { const rx = dateRegex(date); return text => rx.test(norm(text)); }
  const wanted = words(team);
  return text => { const have = new Set(words(opponentPart(text))); return wanted.length > 0 && wanted.every(w => have.has(w)); };
}

// Liens « Réserver » des matchs visés (dans l'ordre de la page), vide s'il n'y est pas (encore).
// Date et adversaire tous deux connus (calendrier du club) : la date d'abord, l'adversaire si la date n'y est pas
// (match reporté, date écrite autrement).
async function findMatchLinks(page, listUrl, { date, team }) {
  const links = await listMatchLinks(page, listUrl);
  if (date) { const byDate = links.filter(l => matcher({ date })(l.text)); if (byDate.length || !team) return byDate; }
  return links.filter(l => matcher({ team })(l.text));
}
// Premier lien « Réserver » du match visé, ou null
async function findMatchLink(page, listUrl, target) { return (await findMatchLinks(page, listUrl, target))[0] || null; }

// Date d'un match d'après le texte de son bloc (« … Samedi 7 Novembre 2026 - 18h00 … »), ou null
function matchDateFromText(text) {
  const m = norm(text).match(new RegExp(`(?:^|[^0-9])(\\d{1,2})(?:er)? (${MONTHS.join('|')}) (20\\d\\d)`));
  return m ? parseMatchDate(`${m[1]} ${m[2]} ${m[3]}`) : null;
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

// Groupes de `places` sièges contigus conformes aux règles, du meilleur au moins bon :
// catégorie, puis rang le plus proche du terrain, puis tirage au sort (pas de course au plein centre)
function candidates({ seats, groups }, places, refused, rules) {
  if (!seats.length) return [];
  const geo = geometry(seats);
  const tiers = categoryTiers(groups);
  const zone = inZone(geo, rules);
  const usable = seats.filter(s => s.free && s.g && tiers[s.g] !== undefined && !refused.has(s.id) && zone(s));
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

const short = name => String(name || '').replace(/^TRIBUNE /i, '');

class Hunt extends BaseHunt {
  // url : page des places du match ; ou, pour trouver le match sur la billetterie à l'ouverture, date : { d, m, y, label }
  // (date du match) et/ou team : nom de l'adversaire
  constructor(o) {
    super(o);
    this.ev = this.url ? eventId(this.url) : null;
    this.isTarget = this.url ? () => false : text => (this.date && matcher({ date: this.date })(text)) || (!!this.team && matcher({ team: this.team })(text));
    this.chrono = { tribunes: {}, reads: 0 };
    this.direct = null; this.directState = 'off'; this.pagesOff = false;
  }

  // Chronologie pour le débogage : temps de chaque étape, envoyé avec la proposition et écrit dans le journal
  chronoText(added, add) {
    const c = this.chrono, ref = Math.max(this.openAt, c.ready || 0);
    const rel = t => `+${fmtSecs(t - ref)} s`;
    const lines = [`⏱ Chronologie (depuis ${this.openAt >= (c.ready || 0) ? "l'heure d'ouverture" : 'le démarrage du navigateur'})`];
    if (c.found) lines.push(`• Bouton « Réserver » détecté : ${rel(c.found)} (${c.reads} lecture(s) de la page, dernière en ${fmtSecs(c.lastRead)} s)`);
    if (c.direct && c.direct.end) lines.push(`• Méthode requêtes prête : ${rel(c.direct.end)} (${fmtSecs(c.direct.end - c.direct.start)} s : ${steps(c.direct.laps)})`);
    for (const k of this.rules.tribunes) {
      const t = c.tribunes[k];
      if (t && t.end && t.end <= added) lines.push(`• Pages : ${short(this.names[k])} prête : ${rel(t.end)} (${fmtSecs(t.end - t.start)} s : ${steps(t.laps)})`);
    }
    if (c.searchStart) lines.push(`• Recherche démarrée : ${rel(c.searchStart)}`);
    lines.push(`• Tour gagnant (${c.round.method}) : lecture des places ${fmtSecs(c.round.refresh)} s, choix ${fmtSecs(c.round.choice)} s`);
    lines.push(`• Ajout au panier : ${fmtSecs(add.serveur || 0)} s (${steps(add)})`);
    lines.push(`• Places au panier : ${rel(added)}${c.found ? ` (${fmtSecs(added - c.found)} s après le bouton)` : ''}`);
    return lines.join('\n');
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
    await loadCart(this.cartPage, this.url || toSeetickets(this.club.list)).catch(e => this.log('page panier :', e.message.split('\n')[0]));
    if (!this.chrono.ready) this.chrono.ready = Date.now();
    this.log('Navigateur prêt');
    this.pages = {}; this.opened = {};
    // Session à part pour la méthode requêtes : le chargement des pages (onglets des tribunes, préchauffage, lecture de
    // la billetterie) réécrit sa session en fin de requête et peut y effacer un panier ajouté en même temps (constaté).
    // Le panier ajouté par requêtes vit donc dans une session que rien d'autre ne touche.
    const params = this.direct && this.direct.params;
    this.dctx = await this.browser.newContext(CONTEXT_OPTIONS);
    this.direct = new Direct(this.dctx);
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
      const l = (await listMatchLinks(scan, this.club.list)).find(x => !this.isTarget(x.text));
      return l && toSeetickets(l.href);
    })();
    if (CONFIG.direct) {
      // Sans autre match en vente (ni lien connu) : paramètres lus sur le match lui-même, une fois trouvé
      this.paramsP = other.then(u => { if (!u && !this.url) throw new Error('pas d\'autre match en vente, lus à l\'ouverture'); return this.direct.loadParams(u || this.url); })
        .then(() => this.log('Paramètres des requêtes prêts'), e => this.log('paramètres des requêtes :', e.message.split('\n')[0]));
    }
    other.then(async u => {
      if (!u) return;
      const w = await this.ctx.newPage();
      const T = Date.now();
      try { await openTribune(w, u, this.rules.tribunes[0]); this.log(`Cache préchauffé sur un autre match (${fmtSecs(Date.now() - T)} s)`); } finally { await w.close(); }
    }).catch(e => this.log('préchauffage :', e.message.split('\n')[0]));
  }

  // Attend le bouton « Réserver » du match sur la page de la billetterie
  async findMatch(scan) {
    this.setState('ouverture', `recherche du match ${this.target} sur la billetterie`);
    let announced = false;
    while (!this.cancelled) {
      try {
        const tr = Date.now();
        const found = await findMatchLinks(scan, this.club.list, { date: this.date, team: this.team });
        this.chrono.reads++; this.chrono.lastRead = Date.now() - tr;
        const link = found[0];
        if (link) {
          // Plusieurs matchs contre le même adversaire (championnat, coupe…) : le premier de la page
          if (found.length > 1) this.events.info(`ℹ️ ${found.length} matchs ${this.target} : choix de ${matchLabel(link.text)}.`);
          this.chrono.found = Date.now();
          // Les onglets des tribunes suivent eux-mêmes le lien (redirection vers la page des places) ;
          // l'identifiant du match est lu dans la redirection (requêtes) ou sur la page d'arrivée (pages)
          this.url = toSeetickets(link.href); this.matchLabel = matchLabel(link.text);
          this.log('Match trouvé :', this.matchLabel, this.url);
          this.log('🎫 En vente, recherche en cours.');
          return true;
        }
      } catch (e) { this.log('billetterie :', e.message.split('\n')[0]); }
      if (!announced && Date.now() >= this.openAt) {
        this.log('⏳ Pas encore en vente, surveillance en cours.');
        announced = true;
      }
      await this.sleep(this.pollDelay());
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
    this.log(`⚠️ Mode rapide en panne (${reason}), poursuite en mode secours.`);
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

  // Vide le panier de la session qui l'a reçu (requêtes ou pages)
  async emptyCart() {
    if (this.cartVia === 'direct') { try { return await this.direct.empty(); } catch (e) { this.log('vidage par requête :', e.message.split('\n')[0]); return -1; } }
    return emptyCart(this.cartPage, this.url);
  }

  // Les places confirmées par le serveur sont-elles bien dans le panier de la session ? (true, false, ou null si inconnu)
  async cartHas(seats) {
    try {
      const lines = this.cartVia === 'direct' ? await this.direct.cartSeats() : (await loadCart(this.cartPage, this.url)).text.match(/Rang \S+ Place [^:]*?(?= Prix|$)/g) || [];
      const text = lines.join(' | ');
      return seats.every(s => new RegExp(`Rang ${s.rang} Place ${String(s.num).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\b|$)`).test(text));
    } catch (e) { this.log('vérification du panier :', e.message.split('\n')[0]); return null; }
  }

  async loop() {
    const { events } = this;
    // 1. Attente jusqu'à peu avant l'ouverture
    if (!(await this.waitOpening())) return 'cancelled';
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
    let active = [...this.rules.tribunes];
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
        if (/absente/.test(e.message)) { active = active.filter(x => x !== k); this.log(`ℹ️ Pas de tribune ${k} pour ce match.`); }
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
            this.log('⏳ Pas encore en vente, surveillance en cours.');
            announced = true;
          }
          await this.sleep(this.directState === 'starting' ? 30 : Object.keys(opening).length ? 100 : 1000);
          continue;
        }
        if (!fastUntil) fastUntil = Math.max(Date.now(), this.openAt) + TIMING.fastWindowMs;
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
          const cands = candidates(datas[k], this.places, this.refused, this.rules);
          status.push(`${short(this.names[k])} : ${datas[k].seats.filter(x => x.free).length} libres, ${cands.length} conformes`);
          if (!best && cands.length) best = { ...cands[0], key: k, data: datas[k] };
        }
        // Panier expiré sans réponse : les mêmes places d'abord, dès que le site les libère
        let renewWait = false;
        if (this.renew) {
          let rg = null;
          for (const k of active) {
            const g = datas[k] && this.renewGroup(datas[k].seats);
            if (g) { const gr = datas[k].groups[g[0].g] || {}; rg = { seats: g, key: k, data: datas[k], cat: gr.name, cents: gr.cents, renewal: this.renew.n }; break; }
          }
          if (rg) best = rg; else if (this.renewing()) { best = null; renewWait = true; }
        }
        this.chrono.round = { refresh: tc - tr, choice: Date.now() - tc, method };
        errors = 0;
        if (status.join(' | ') !== lastStatus) { lastStatus = status.join(' | '); this.log(`#${round} [${method}] ${lastStatus} (${Date.now() - t0} ms)`); }
        if (!best && renewWait) { this.setState('recherche', 'reprise des places expirées'); await this.sleep(TIMING.fastMs); continue; }
        if (!best) {
          const fast = waiting || Date.now() < fastUntil;
          this.setState('recherche', waiting ? 'ouverture des tribunes' : `aucune place conforme, ${fast ? 'rythme rapide' : `nouvel essai toutes les ${TIMING.slowMs / 1000} s`}`);
          if (!idleAnnounced && !fast) { this.log('🔎 Rien de conforme pour l\'instant, surveillance en cours.'); idleAnnounced = true; }
          await this.sleep(waiting ? 100 : fast ? TIMING.fastMs : TIMING.slowMs);
          continue;
        }
        const desc = `${this.names[best.key]} - ${best.cat} - rang ${best.seats[0].rang} places ${best.seats.map(x => x.num).join(', ')}`;
        this.setState('recherche', `tentative : ${desc}`);
        this.log(`Tentative [${method}] :`, desc);
        const addLaps = {};
        let res;
        this.cartVia = direct ? 'direct' : 'pages';
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
          // Garde-fou : places confirmées mais absentes du panier de la session (session réécrite en même temps) :
          // ne pas proposer un panier impossible à payer, continuer la recherche (ces places sont bloquées jusqu'à expiration)
          const tv = Date.now(), has = await this.cartHas(best.seats);
          addLaps['vérification'] = (addLaps.serveur || 0) + Date.now() - tv;
          if (has === false) { this.log('Places confirmées mais absentes du panier : recherche poursuivie'); await this.emptyCart().catch(() => {}); continue; }
          if (direct) this.stopPages('ajout réussi');
          idleAnnounced = false;
          const added = Date.now();
          const timing = this.timing(t0, added, tStart);
          const price = best.cents ? ` - ${((best.cents * this.places) / 100).toFixed(2).replace('.', ',')} €` : '';
          const chrono = this.chronoText(added, addLaps);
          this.log(chrono);
          this.setState('proposition', desc);
          this.renew = null;
          const decision = await events.proposal({
            desc: desc + price, timing, chrono, seats: best.seats, expiresAt: added + CONFIG.cartMs,
            renewal: best.renewal || 0, renewNext: this.renewNext(best.seats), renewMax: this.renewMax,
            // Le lien ouvre la page de commande dans la session du bot (le site l'adopte) : se connecter, puis payer
            link: await pickupLink(this.cartVia === 'direct' ? this.dctx : this.ctx), linkText: '🎟 Ouvrir le panier', released: 'now',
            // Image générée seulement quand l'appelant la demande, sans bloquer la proposition
            // État du plan juste avant l'ajout (juste après, le plan recharge ses statuts et paraît tout libre)
            image: () => seatMapImage(this.browser, best.data.seats, best.seats, desc, this.rules),
          });
          if (decision === 'keep') { this.setState('terminé', desc); return 'kept'; }
          // Match supprimé : panier vidé (places libérées tout de suite), puis arrêt
          if (decision === 'cancel') { const left = await this.emptyCart().catch(() => -1); if (left) this.log(`Panier non vidé (${left})`); return 'cancelled'; }
          if (decision === 'refuse') best.seats.forEach(x => this.refused.add(x.id));
          if (decision === 'expired') this.expired(best.seats);
          const left = await this.emptyCart();
          if (left) this.log(`Panier non vidé (${left} place(s))`);
          fastUntil = Date.now() + TIMING.fastWindowMs;
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

module.exports = { Hunt, CONFIG, candidates, categoryTiers, tryAdd, matcher, findMatchLink, findMatchLinks, listMatchLinks, matchDateFromText, matchLabel, toSeetickets };
