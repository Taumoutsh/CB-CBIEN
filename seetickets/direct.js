// Méthode « requêtes » : les mêmes requêtes que le plan du site, sans charger de page (≈ 1 s au lieu de ≈ 8 à 10 s
// pour lire les 4 tribunes). Utilise la session (cookies) du contexte navigateur : le panier est le même que celui
// des pages. Toute réponse inattendue lève une erreur : l'appelant repasse alors sur la méthode des pages.
const API = 'https://billetterie.seetickets.fr/ext/billetterie5/index.php';
const HEADERS = { 'x-requested-with': 'XMLHttpRequest', accept: 'application/json, text/javascript, */*; q=0.01' };
// Paramètres d'affichage du plan, recopiés des requêtes du site (salle de la Meilleraie)
const MAP_OPTIONS = { seatCellSize: '30,30', gridRender: 'canvas', mapWidth: 1500, referenceSectionId: 58465 };
const flat = v => (Array.isArray(v) ? v.flatMap(flat) : v && typeof v === 'object' ? Object.values(v).flatMap(flat) : [v]);

class Direct {
  constructor(ctx) { this.rq = ctx.request; this.grids = {}; this.params = null; }

  // Paramètres de la salle (roomConfigId, dataSiteIds, channelIds, site), lus dans le code HTML d'une page de match.
  // Identiques d'un match à l'autre dans la même salle : lus pendant la préparation sur un autre match si possible.
  async loadParams(matchUrl) {
    const r = await this.rq.get(matchUrl, { timeout: 15000 });
    const html = await r.text();
    const get = k => (html.match(new RegExp(`["']?${k}["']?\\s*[:=]\\s*["'\\[]?(\\d+)`)) || [])[1];
    const site = (r.url().match(/css5-([a-z0-9]+)-pg/) || [])[1];
    const p = { roomConfigId: get('roomConfigId'), dataSiteIds: get('dataSiteIds'), channelIds: get('channelIds'), site };
    if (!p.roomConfigId || !p.dataSiteIds || !p.channelIds || !site) throw new Error('paramètres du plan introuvables');
    this.params = p;
    return { ...p, showId: get('showId'), url: r.url() };
  }

  // Lien « Réserver » (…-ei…) → identifiant du match, lu dans la redirection sans la suivre
  async resolve(link) {
    const r = await this.rq.get(link, { maxRedirects: 0, timeout: 15000 });
    const loc = r.headers().location || '';
    const m = loc.match(/-ri(\d+)\.html/);
    if (m) { this.show = m[1]; this.referer = new URL(loc, link).href; return this.show; }
    // Pas de redirection : page du match directe
    const info = await this.loadParams(link);
    if (!info.showId) throw new Error('identifiant du match introuvable');
    this.show = info.showId; this.referer = info.url;
    return this.show;
  }

  async post(form, query = '') {
    if (!this.params) throw new Error('paramètres du plan non chargés');
    const r = await this.rq.post(API + query, { form, headers: { ...HEADERS, referer: this.referer || API }, timeout: 15000 });
    if (r.status() !== 200) throw new Error(`réponse HTTP ${r.status()}`);
    let j;
    try { j = await r.json(); } catch (e) { throw new Error('réponse non JSON'); }
    return j;
  }

  base() {
    const p = this.params;
    return { p: 11, px: 39, previewImg: 1, site: p.site, dataSiteIds: p.dataSiteIds, channelIds: p.channelIds, globalMapVersion: 3, filterPackPrices: 1, filterCodePromo: 0, params: 1, useConfidentiality: 'false' };
  }

  // Noms des tribunes : { idSection: nom }
  async sections() {
    const j = await this.post({ ...this.base(), action: 'map.room', roomConfigId: this.params.roomConfigId, isMultiple: 'true', mapWidth: 620 });
    if (j.code !== 0 || !j.data || !j.data.roomSectionNames) throw new Error('liste des tribunes inattendue');
    return j.data.roomSectionNames;
  }

  // Grille d'une tribune (positions, rangs, numéros) : ne change pas, gardée en mémoire
  async grid(id) {
    if (this.grids[id]) return this.grids[id];
    const j = await this.post({ ...this.base(), action: 'map.roomSection.map', roomSectionId: id, ...MAP_OPTIONS, roomConfigId: this.params.roomConfigId, showId: this.show });
    if (j.code !== 0 || !j.data || !j.data.grid || !j.data.seats) throw new Error('grille inattendue');
    const d = j.data, cells = [];
    for (const [y, row] of Object.entries(d.grid)) {
      for (const [x, sid] of Object.entries(row || {})) {
        const se = d.seats[sid];
        const rang = se && (se.rang || (d.rows || {})[y]);
        if (se && rang) cells.push({ id: Number(sid), x: +x, y: +y, cellId: Number(sid), rang, num: se.numero });
      }
    }
    if (!cells.length) throw new Error('grille vide');
    return (this.grids[id] = cells);
  }

  // Sièges de la tribune au format de readSeats (common.js) : { seats, groups }. Libre = dans une catégorie de prix
  // et dans aucune liste d'état (vendu, abonné, gardé, au panier…) : tout état inconnu compte comme pris.
  async read(id) {
    const [cells, j] = await Promise.all([
      this.grid(id),
      this.post({ ...this.base(), action: 'map.roomSection.seatStates', showId: this.show, knownPriceIds: '', knownPricesGroupIds: '', roomSectionId: id, knownReservoirs: '' }),
    ]);
    const d = j.data;
    if (j.code !== 0 || !d || !d.pricesGroups || !d.prices || !d.pricesGroupsSeats || !d.seatStates) throw new Error('statuts inattendus');
    const notFree = new Set(flat(d.seatStates[this.show] || {}).map(Number));
    const group = {};
    for (const [g, ids] of Object.entries(d.pricesGroupsSeats[this.show] || {})) for (const sid of flat(ids)) group[Number(sid)] = g;
    const groups = {};
    for (const [g, gd] of Object.entries(d.pricesGroups)) {
      const plein = Object.keys(gd.prices || {}).map(pid => d.prices[pid]).filter(p => p && /PLEIN TARIF/.test(p.customerTypeName)).sort((a, b) => b.cents - a.cents)[0];
      groups[g] = { name: gd.name, cents: plein ? plein.cents : 0, priceId: plein && plein.id };
    }
    const seats = cells.map(c => ({ ...c, g: group[c.id] || null, free: !!group[c.id] && !notFree.has(c.id) }));
    return { seats, groups };
  }

  // Ajout au panier, plein tarif ; même réponse que via la page (cart2.success)
  async add(seats, priceId) {
    if (!priceId) throw new Error('tarif plein introuvable');
    const form = { p: 11, px: 1, action: 'add', panier: '', submitAction: 'addToCart' };
    for (const s of seats) { form[`cart2[${this.show}][${s.id}]`] = priceId; form[`codesPromo[${this.show}][${s.id}]`] = ''; }
    return this.post(form, `?site=${this.params.site}&p=11`);
  }

  // Vide le panier ; renvoie le nombre de lignes restantes
  async empty() {
    const j = await this.post({ px: 1, action: 'sup', panier: 1, isEtape1Recap: 'false' }, `?site=${this.params.site}&p=11`);
    if (!j || !Array.isArray(j.panier)) throw new Error('vidage : réponse inattendue');
    return j.panier.length;
  }
}

module.exports = { Direct };
