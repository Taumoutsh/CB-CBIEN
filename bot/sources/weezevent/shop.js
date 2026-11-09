// Billetterie Weezevent : liste des matchs et session d'achat, du choix des sièges au lien de paiement.
//
// Parcours d'une commande (testé sur la billetterie des Ducs d'Angers) :
//   1. page du match (widget_billeterie.php, clé « E<n° du match> ») : plan 3D des zones (Pacifa, cadre about:srcdoc) ;
//   2. sièges : une requête par zone (pyvar.weezevent.net) donne chaque siège, son rang, sa position, son contingent et
//      « available ». Attention : un siège réservé par un autre panier y reste « disponible » ;
//   3. sélection dans le plan : zone, « Choisir un siège », siège, tarif, « Ajouter au panier » (le panier n'existe que
//      dans la page) ; puis « SUITE » : c'est là que le site réserve les sièges (10 min) ou répond « Les places
//      sélectionnées ne sont plus disponibles » ;
//   4. coordonnées : un bloc par billet (prénom, nom, email) et un bloc acheteur (civilité, date de naissance, adresse,
//      téléphone…), conditions générales de vente ; puis « Acheter » : la page de paiement payment.weezevent.com/<id>
//      s'ouvre sur n'importe quel appareil, sans cookie.
const { norm, dateOf, parisTime } = require('../../lib/dates');

const API = 'https://api.weezevent.com/ticket/widgets/';
const eventUrl = id => `https://www.weezevent.com/widget_billeterie.php?id_evenement=${id}&widget_key=E${id}&locale=fr_FR`;

// Date et heure de Paris d'après un horodatage sans fuseau (« 2026-10-07T16:00:00 ») ou en UTC (« …Z »)
function parseStamp(s) {
  if (!s) return null;
  if (/Z|[+-]\d\d:?\d\d$/.test(s)) return new Date(s);
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/);
  return m ? parisTime(+m[1], +m[2], +m[3], +m[4], +m[5]) : null;
}
// « ANGERS - CERGY PONTOISE (27.11.26 SLM) » → { opponent: 'CERGY PONTOISE', competition: 'SLM' }
function parseEventName(name) {
  const m = name.match(/^.+?\s+-\s+(.+?)\s*\((?:\d\d\.\d\d\.\d\d)?\s*([^)]*)\)\s*$/) || name.match(/^.+?\s+-\s+(.+)$/);
  return m ? { opponent: m[1].trim(), competition: (m[2] || '').trim() } : null;
}

// Matchs des billetteries (clés de widget) : [{ id, name, opponent, competition, date, at, saleStart, url }].
// Les événements qui ne sont pas des matchs (campagne d'adhésion…) sont ignorés.
async function listEvents(request, widgets) {
  const out = [];
  for (const w of widgets) {
    const j = await (await request.get(API + w, { headers: { accept: 'application/json' }, timeout: 15000 })).json();
    for (const we of j.widget_events || []) {
      const e = we.event || {}, n = parseEventName(e.name || ''), at = parseStamp(e.start_date);
      if (!n || !at || e.publication_status !== 'published' || e.time_status === 'past') continue;
      const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(at).split('-').map(Number);
      out.push({ id: e.id, name: e.name, ...n, date: dateOf(d[2], d[1], d[0]), at, saleStart: parseStamp(e.sale_start_date), url: eventUrl(e.id) });
    }
  }
  const seen = new Set();
  return out.filter(e => !seen.has(e.id) && seen.add(e.id)).sort((a, b) => a.at - b.at);
}

class Session {
  // ctx : contexte navigateur propre à cette commande ; url : page du match
  constructor(ctx, url) { this.ctx = ctx; this.url = url; this.page = null; }
  close() { return this.ctx.close().catch(() => {}); }
  frame() { return this.page.frames().find(f => f.url() === 'about:srcdoc'); }
  text() { return this.page.evaluate('document.body.innerText').then(t => t.replace(/\n+/g, ' | ')); }

  // Page du match et zones du plan (réponse « zones/root » du plan, lue au chargement)
  async open() {
    const p = this.page = await this.ctx.newPage();
    let root = null;
    const h = async r => { if (/pyvar.*\/zones\/root/.test(r.url())) { try { this.rootUrl = r.url(); root = await r.json(); } catch (e) {} } };
    p.on('response', h);
    await p.goto(this.url, { waitUntil: 'networkidle', timeout: 60000 });
    p.off('response', h);
    this.root = root;
    // Zones cliquables sur le plan : certaines zones de l'API n'y figurent pas (leurs sièges ne peuvent pas être pris)
    let blocks = [];
    for (let i = 0; i < 30 && !blocks.length; i++) {
      const f = this.frame();
      blocks = f ? await f.evaluate(() => [...document.querySelectorAll('[data-block]')].map(e => e.getAttribute('data-block'))).catch(() => []) : [];
      if (!blocks.length) await p.waitForTimeout(500);
    }
    this.blocks = new Set(blocks);
    return !!root;
  }

  // Sièges des zones voulues, d'après l'API du plan : [{ zone: { uuid, name, block }, seats: [...] }]
  // Siège : { id (code Pacifa « B44R1S111 »), x, y, rang, row, num, free, rates (tarifs tout public de son contingent) }
  async zones(rules) {
    const block = z => (z.seatlib_data || {}).pacifa_id || z.pacifa_id;
    const want = z => rules.zones.some(k => norm(z.name).includes(norm(k))) && !rules.exclude.some(k => norm(z.name).includes(norm(k))) && this.blocks.has(block(z));
    const tarif = new RegExp(rules.tarif, 'i'), exclude = new RegExp(rules.tarifExclu, 'i');
    const out = [];
    await Promise.all((this.root.children || []).filter(want).map(async z => {
      // Catégorie et contingent (lot de places) avec un tarif tout public en vente ; catégories PMR écartées
      // (leurs sièges peuvent partager le contingent de la catégorie voisine)
      const rates = {};
      for (const k of z.categories || []) {
        if (exclude.test(k.name || '')) continue;
        for (const c of k.contingents || []) {
          const r = (c.rates || []).filter(x => tarif.test(x.name) && !exclude.test(x.name) && x.available !== 'no').map(x => x.name);
          if (r.length && c.seated !== false) rates[`${k.uuid}:${c.uuid}`] = r;
        }
      }
      if (!Object.keys(rates).length) return;
      const j = await (await this.ctx.request.get(this.rootUrl.replace('/zones/root', `/zones/${z.uuid}`), { timeout: 15000 })).json();
      const seats = (j.seats || []).map(s => ({
        id: s.pacifa_id, x: s.x, y: s.y, rang: String(s.row), row: `${z.uuid}:${s.row}`, num: s.seat,
        open: !!s.available, free: !!s.available && !!rates[`${s.category}:${s.contingent}`], rates: rates[`${s.category}:${s.contingent}`] || [],
      }));
      out.push({ zone: { uuid: z.uuid, name: z.name, block: block(z) }, seats });
    }));
    return out;
  }

  // Ouvre une zone du plan (bloc), puis « Choisir un siège » ; renvoie le cadre du plan des sièges, ou null
  async openZone(block) {
    const p = this.page;
    const f = this.frame();
    const s = f && await f.evaluate(b => { const e = document.querySelector(`[data-block="${b}"]`); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, block);
    if (!s) return null;
    const box = await (await f.frameElement()).boundingBox();
    const choose = p.getByText('Choisir un siège').first();
    for (let i = 0; i < 3 && !(await choose.isVisible().catch(() => false)); i++) { await p.mouse.click(box.x + s.x, box.y + s.y); await choose.waitFor({ timeout: 3000 }).catch(() => {}); }
    await choose.click({ timeout: 5000 });
    // Le site remplace le cadre du plan par celui des sièges de la zone
    for (let i = 0; i < 60; i++) {
      for (const ff of p.frames().filter(x => x.url() === 'about:srcdoc')) {
        if (await ff.evaluate(() => document.querySelectorAll('[data-seat]').length).catch(() => 0)) return ff;
      }
      await p.waitForTimeout(250);
    }
    return null;
  }

  // Sièges au panier un par un (plan de la zone, tarif voulu), puis « SUITE » : true si le site réserve les sièges,
  // false s'il les refuse (pris entre-temps) ou refuse la sélection (siège isolé).
  async select(zone, seats, tarif, exclude) {
    const p = this.page;
    const reTarif = new RegExp(tarif, 'i'), reEx = new RegExp(exclude, 'i');
    for (const seat of seats) {
        let f = null;
      for (const x of this.page.frames().filter(x => x.url() === 'about:srcdoc')) if (await x.$(`[data-seat="${seat.id}"]`).catch(() => null)) f = x;
      if (!f) f = await this.openZone(zone.block);
      const el = f && await f.evaluate(c => { const e = document.querySelector(`[data-seat="${c}"]`); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, seat.id);
      if (!el) { this.why = `zone ${zone.name} sans sièges sur le plan`; this.zoneMissing = true; return false; }
      const box = await (await f.frameElement()).boundingBox();
      await p.mouse.click(box.x + el.x, box.y + el.y);
      const submit = p.locator('.seat-modal-button-submit');
      if (!(await submit.first().waitFor({ timeout: 6000 }).then(() => true, () => false))) {
        this.why = ((await this.text()).match(/Vous ne pouvez[^|]*/) || ['siège non sélectionnable'])[0].trim();
        return false;
      }
      // Tarif tout public (le nom du tarif est la valeur du bouton radio)
      const picked = await p.evaluate(([re, ex]) => {
        const rs = [...document.querySelectorAll('input[name=select-rates]')];
        const r = rs.find(r => new RegExp(re, 'i').test(r.value) && !new RegExp(ex, 'i').test(r.value) && !/EARLY/i.test(r.value)) || rs.find(r => new RegExp(re, 'i').test(r.value) && !new RegExp(ex, 'i').test(r.value));
        if (r) { r.click(); return r.value; } return null;
      }, [reTarif.source, reEx.source]);
      if (!picked) { this.why = 'pas de tarif tout public pour ce siège'; return false; }
      seat.tarif = picked;
      await p.locator('.seat-modal-button-submit:not([disabled])').first().click({ timeout: 5000 });
      await p.locator('.seat-modal-button-submit').first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    }
    // « SUITE » : réservation des sièges par le site, ou refus
    await p.locator('button:has-text("SUITE"), input[value=SUITE], a:has-text("SUITE")').last().click({ timeout: 10000 });
    const r = await Promise.race([
      p.waitForFunction(() => /Temps restant/.test(document.body.innerText), null, { timeout: 30000 }).then(() => 'ok'),
      p.waitForFunction(() => /ne sont plus disponibles/.test(document.body.innerText), null, { timeout: 30000 }).then(() => 'pris'),
    ]).catch(() => 'inconnu');
    if (r !== 'ok') { this.why = r === 'pris' ? 'places prises entre-temps' : 'pas de réponse du site'; return false; }
    this.expiresAt = await this.expiry();
    return true;
  }

  // Fin du panier : « Temps restant : 9 minutes 46 secondes »
  async expiry() {
    const m = (await this.text()).match(/Temps restant\s*:?\s*(\d+)\s*minutes?\s*(?:(\d+)\s*secondes?)?/);
    return Date.now() + (m ? (+m[1] * 60 + (+m[2] || 0)) * 1000 : 10 * 60000);
  }

  // Coordonnées : blocs des billets (prénom, nom, email de l'acheteur) et bloc acheteur, conditions générales de vente
  // acceptées, pas d'offres commerciales ; puis « Acheter » : renvoie { link (page de paiement), expiresAt }.
  async checkout(buyer) {
    const p = this.page;
    await p.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    await p.waitForSelector('.fieldWrapper input', { timeout: 20000 }).catch(() => {});
    this.trace = [];
    for (let i = 0; i < 12; i++) {
      const r = await p.evaluate(fillPass, buyer);
      this.trace.push(r);
      if (r.unknown.length) throw new Error(`champ des coordonnées inconnu du bot : ${r.unknown.join(', ')}`);
      if (!r.changed) break;
      await p.waitForTimeout(800);
    }
    await p.locator('button:has-text("SUITE"), input[value=SUITE], a:has-text("SUITE")').last().click({ timeout: 10000 });
    const pay = p.locator('#submitPaymentForm');
    if (!(await pay.waitFor({ timeout: 30000 }).then(() => true, () => false))) {
      const err = ((await this.text()).match(/Veuillez[^|]*|[^|]*obligatoire[^|]*/) || [''])[0].trim();
      if (process.env.DEBUG_DIR) {
        await p.screenshot({ path: require('path').join(process.env.DEBUG_DIR, 'coordonnees-refusees.png'), fullPage: true }).catch(() => {});
        console.log('remplissage :', JSON.stringify(this.trace));
      }
      throw new Error(`coordonnées refusées par le site${err ? ` : ${err}` : ''}`);
    }
    const expiresAt = await this.expiry();
    // Prix total de la commande, tel qu'affiché à l'étape Paiement : « TOTAL (TTC) 25,00 € »
    const total = totalOf(await this.text());
    // « Acheter » ouvre la page de paiement de la commande (aucune donnée de carte n'est saisie) ; le bouton n'est actif
    // qu'une fois le module de paiement de la page chargé
    await p.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    const payUrl = () => [p.url(), ...p.frames().map(f => f.url())].find(u => /^https:\/\/payment\.weezevent\.com\/[0-9a-f-]{20,}/.test(u));
    for (let i = 0; i < 2 && !payUrl(); i++) {
      await pay.click({ timeout: 10000 }).catch(() => {});
      for (let k = 0; k < 40 && !payUrl(); k++) await p.waitForTimeout(500);
    }
    if (!payUrl()) throw new Error('page de paiement non ouverte par le site');
    return { link: payUrl(), expiresAt, total };
  }
}

// Remplit les champs visibles d'après leur libellé ; exécutée dans la page. { changed, unknown }
function fillPass(buyer) {
  const labelOf = e => { const w = e.closest('.fieldWrapper'); const l = (w && w.querySelector('.fieldLabel')) || (e.id && document.querySelector(`label[for="${e.id}"]`)); return ((l && l.innerText) || e.placeholder || '').replace(/\s+/g, ' ').trim(); };
  const norm = t => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const set = (e, v) => { const proto = Object.getPrototypeOf(e); Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, v); for (const t of ['input', 'change', 'blur']) e.dispatchEvent(new Event(t, { bubbles: true })); };
  const [jj, mm, aaaa] = (buyer.naissance || '').split('/');
  const MONTHS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
  let changed = false;
  const unknown = [], filled = [];
  for (const e of document.querySelectorAll('input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not([type=submit]):not([type=button]), textarea')) {
    if (!e.offsetParent || e.value || !e.name) continue;
    const l = norm(labelOf(e));
    const v = /confirm/.test(l) && /mail/.test(l) ? buyer.email : e.type === 'email' || /e-?mail/.test(l) ? buyer.email
      : /prenom/.test(l) ? buyer.prenom : /^nom\b/.test(l) ? buyer.nom : /adresse/.test(l) ? buyer.adresse
      : /code postal/.test(l) ? buyer.codePostal : /ville/.test(l) ? buyer.ville : /telephone|portable|mobile/.test(l) ? buyer.telephone : null;
    if (v) { set(e, v); changed = true; filled.push(e.name); } else if (e.required) unknown.push(labelOf(e) || e.name);
  }
  // Téléphone : selon la page, le champ visible (module d'indicatif pays) est celui envoyé, ou un champ sans nom
  // doublé d'un champ caché envoyé, qui reçoit alors le numéro international
  for (const w of document.querySelectorAll('.fieldWrapper')) {
    if (!/telephone/.test(norm((w.querySelector('.fieldLabel') || {}).textContent || ''))) continue;
    const vis = [...w.querySelectorAll('input')].find(i => i.offsetParent && !i.name), named = [...w.querySelectorAll('input[name]')].find(i => /^champs_/.test(i.name));
    if (vis && !vis.value) { set(vis, buyer.telephone); changed = true; }
    if (vis && named && vis.value && !named.value) {
      let intl = '+33' + vis.value.replace(/\D/g, '').replace(/^0/, '');
      try { const g = window.intlTelInputGlobals && window.intlTelInputGlobals.getInstance(vis); if (g && g.getNumber()) intl = g.getNumber(); } catch (e) { /* format français par défaut */ }
      named.value = intl; changed = true;
    }
  }
  // Date de naissance (jour / mois / année) et civilité
  for (const e of document.querySelectorAll('select')) {
    if (!e.offsetParent) continue;
    const l = norm(labelOf(e));
    let o = null;
    if (/_day$/.test(e.name)) o = [...e.options].find(x => +x.text === +jj);
    else if (/_month$/.test(e.name)) o = [...e.options].find(x => norm(x.text) === MONTHS[+mm - 1] || +x.value === +mm);
    else if (/_year$/.test(e.name)) o = [...e.options].find(x => x.text.trim() === aaaa);
    else if (/civilit/.test(l)) o = [...e.options].find(x => (/^m(me|adame)/i.test(buyer.civilite) ? /^mme|madame/i : /^(mr|m)\.?$|monsieur/i).test(x.text.trim()));
    else if (e.value || !(e.required || /\*/.test(labelOf(e)))) continue;
    if (o) { if (e.value !== o.value) { set(e, o.value); changed = true; } } else if (!e.value || /_(day|month|year)$/.test(e.name)) unknown.push(labelOf(e) || e.name);
  }
  // Conditions générales de vente : acceptées ; offres commerciales : non cochées
  const cgv = document.querySelector('#accepte_cgv');
  if (cgv && cgv.offsetParent && !cgv.checked) { cgv.click(); changed = true; }
  // Bloc d'un billet rempli : « Continuer » ouvre le bloc suivant
  const cont = [...document.querySelectorAll('a.valide_participant')].find(a => a.offsetParent);
  if (cont && !unknown.length && changed) cont.click();
  else if (cont && !unknown.length) { cont.click(); changed = true; }
  return { changed, unknown, filled, continuer: !!cont };
}

// « … | TOTAL (TTC)	25,00 € | ACHETER 25,00 € » → « 25,00 € » (null si absent)
function totalOf(text) {
  const m = String(text).match(/TOTAL \(TTC\)\s*\|?\s*([\d\s\u00a0\u202f.,]+?)\s*€/);
  return m ? `${m[1].replace(/[\s\u00a0\u202f]/g, '').replace('.', ',')} €` : null;
}

module.exports = { totalOf, listEvents, parseEventName, parseStamp, eventUrl, Session };
