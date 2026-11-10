// Méthode « requêtes » de la billetterie Weezevent : le même parcours que la session par navigateur (shop.js), sans
// charger la page ni son plan 3D. Même interface que Session : open, zones, select, checkout, close.
//
// Cinq envois, relevés sur le parcours réel du site :
//   1. API des widgets (clé « E<n° du match> ») : étape d'entrée. « redirect » : vente ouverte, jeton d'entrée et adresse
//      de la billetterie ; « queue » : compte à rebours avant l'ouverture, ou file d'attente du site (classe Gate) ;
//   2. envoi du jeton : page de la billetterie (session « wsid », formulaire du panier, tarifs et prix, identifiants du plan) ;
//   3. formulaire du panier avec « cart_json » (une entrée par siège : plan, inventaire, zone, catégorie, tarif) :
//      le site réserve les sièges et renvoie la page des coordonnées, ou la page du panier s'ils sont pris ;
//   4. formulaire des coordonnées : page de l'étape Paiement, avec le jeton de paiement ;
//   5. demande de paiement (lyria.weezevent.com) : identifiant de la page payment.weezevent.com/<id>.
// Toute réponse que le bot ne reconnaît pas lève une erreur Unexpected : le moteur repasse alors à la session par
// navigateur.
const { readZones, API } = require('./shop');

// Réponse du site que la méthode par requêtes ne reconnaît pas (le site a peut-être changé)
class Unexpected extends Error {}

// Entrée de la billetterie d'un match. Avant l'ouverture et quand le site est très demandé, l'API ne donne pas l'accès
// mais un ticket de file d'attente (étape « queue ») : un jeton valable 15 s après son émission et 5 min durant, à
// renvoyer pour obtenir l'étape suivante (la file encore, avec un nouveau jeton, ou l'accès). Le ticket est gardé d'un
// essai à l'autre, comme la page du site restée ouverte : il garde sa place dans la file.
class Gate {
  constructor(eventId) { this.key = `E${eventId}`; this.kept = null; this.probed = 0; this.queued = false; this.rank = null; }

  // Étape d'entrée (step absent), ou étape suivante d'un ticket de file ; null si le site refuse le jeton
  async read(request, step) {
    const o = { headers: { accept: 'application/json' }, timeout: 15000 };
    if (!step) {
      const r = await request.get(API + this.key, o);
      if (!r.ok()) throw new Error(`entrée de la billetterie : réponse HTTP ${r.status()}`);
      return (await r.json()).first_step;
    }
    const r = await request.post(`${API}${this.key}/steps/${step.slug}`, { ...o, headers: { ...o.headers, authorization: `Bearer ${step.token}` }, data: {} });
    return r.ok() ? r.json() : null;
  }

  // Ticket de file gardé : heure d'envoi du jeton (dès qu'il est valable, ou à l'ouverture de la vente si elle tombe
  // pendant sa validité) et fin de validité, d'après les durées du jeton (horloge du site)
  keep(step) {
    const p = JSON.parse(Buffer.from(step.token.split('.')[1], 'base64url').toString());
    const now = Date.now(), life = (p.exp - p.iat) * 1000;
    const c = +(((step.data || {}).countdown || {}).countdown) || 0;
    let due = now + Math.max(0, (p.nbf - p.iat) * 1000) + 300;
    if (c > 0 && now + c * 1000 > due && c * 1000 < life - 20000) due = now + c * 1000 + 200;
    return { step, due, until: now + life, countdown: c > 0, opens: now + c * 1000 };
  }

  // Accès à la billetterie : { url, query, parameters } de la page à demander ; null tant que la vente n'est pas ouverte
  // ou que le tour dans la file n'est pas venu
  async enter(request) {
    const k = this.kept, now = Date.now();
    let step = null;
    if (k && now >= k.until) this.kept = null;
    else if (k && now >= k.due) { this.kept = null; step = await this.read(request, k.step); }
    // Entre deux envois du ticket gardé, une nouvelle entrée sert de sonde : à chaque essai à l'approche de l'ouverture
    // annoncée et après elle, toutes les 3 s dans la file ; aucune tant que l'ouverture est à plus de 20 s
    else if (k && (k.countdown ? k.opens - now > 20000 : now - this.probed < 3000)) return null;
    if (!step) { this.probed = now; step = await this.read(request, null); }
    const act = step && ((step.data || {}).actions || []).find(a => a.action === 'form');
    const arg = act && act.args && act.args[0];
    if (arg && arg.url && arg.parameters) { this.kept = null; this.queued = false; return arg; }
    if (!step || step.slug !== 'queue' || !step.token) throw new Unexpected('entrée de la billetterie inattendue');
    if (!this.kept) this.kept = this.keep(step);
    // File d'attente réelle : plus de compte à rebours, et une position annoncée par le site
    this.rank = this.kept.countdown ? null : (this.kept.step.data || {}).rank || null;
    this.queued = !!this.rank;
    return null;
  }
}

// ─── Fonctions exécutées dans une page vide (analyse du HTML reçu) ───

// Champs d'un formulaire comme le navigateur les enverrait : [[nom, valeur]]
const SERIALIZE = `function serialize(form) {
  const out = [];
  for (const e of form.elements) {
    if (!e.name || e.disabled || ['submit', 'button', 'file', 'image', 'reset'].includes(e.type)) continue;
    if ((e.type === 'checkbox' || e.type === 'radio') && !e.checked) continue;
    if (e.tagName === 'SELECT' && e.multiple) { for (const o of e.selectedOptions) out.push([e.name, o.value]); continue; }
    out.push([e.name, e.value]);
  }
  return out;
}`;

// Page de la billetterie : formulaire du panier, session, tarifs (prix, TVA), identifiants du plan
const PARSE_ENTRY = new Function('html', `${SERIALIZE}
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const f = doc.querySelector('#FormBilleterie');
  if (!f) return null;
  const val = id => (doc.getElementById(id) || {}).value || '';
  const rates = {};
  for (const s of doc.querySelectorAll('select.quantitySelect')) rates[s.getAttribute('data-ticket_id')] = { price: +s.getAttribute('data-prix'), tax: s.getAttribute('data-tax_id') || '' };
  let contingents = [];
  try { contingents = JSON.parse(val('contingents')); } catch (e) { /* aucun */ }
  return { action: f.getAttribute('action'), fields: serialize(f), wsid: (f.querySelector('[name=wsid]') || {}).value, rates,
    chartId: val('chartId'), inventory: val('defaultInventory'), contingents, ivar: val('ivarAPIRoute') };`);

// Page des coordonnées : champs du formulaire avec leur libellé, pour les remplir
const PARSE_FORM = new Function('html', `
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const f = doc.querySelector('#FormBilleterie');
  if (!f) return null;
  const step = (f.querySelector('[name=current_step]') || {}).value;
  const fields = [];
  for (const e of f.elements) {
    if (!e.name || e.disabled || ['submit', 'button', 'file', 'image', 'reset'].includes(e.type)) continue;
    const w = e.closest('.fieldWrapper'), l = w && w.querySelector('.fieldLabel'), lab = e.id && doc.querySelector('label[for="' + e.id + '"]');
    fields.push({ name: e.name, tag: e.tagName, type: e.type, value: e.value, checked: !!e.checked, required: !!e.required,
      label: ((l && l.textContent) || (lab && lab.textContent) || '').replace(/\\s+/g, ' ').trim(),
      options: e.tagName === 'SELECT' ? [...e.options].map(o => ({ value: o.value, text: o.textContent.trim() })) : null });
  }
  const pay = doc.querySelector('#lyriaPayData');
  return { action: f.getAttribute('action'), step, fields, text: doc.body.textContent.replace(/\\s+/g, ' '),
    lyria: pay ? { url: pay.getAttribute('data-lyriaurl'), token: pay.getAttribute('data-token') } : null };`);

const norm = t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const MONTHS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
// Fin du panier d'après la page : « var dateExpiration = "600" » (secondes restantes)
const expiryOf = html => Date.now() + (+((html.match(/dateExpiration\s*=\s*"(\d+)"/) || [])[1] || 600)) * 1000;

class Direct {
  // ctx : contexte navigateur propre à cette commande (ses cookies) ; gate : entrée de la billetterie du match
  constructor(ctx, gate) { this.ctx = ctx; this.rq = ctx.request; this.gate = gate; this.page = null; }
  close() { return this.ctx.close().catch(() => {}); }

  async post(url, options) {
    const r = await this.rq.post(url, { timeout: 20000, ...options });
    if (r.status() !== 200) throw new Error(`réponse HTTP ${r.status()}`);
    return r.text();
  }

  // Envois 1 et 2 : session de la billetterie et plan. false tant que la vente n'est pas ouverte (ou file d'attente).
  async open() {
    const arg = await this.gate.enter(this.rq);
    if (!arg) return false;
    this.page = await this.ctx.newPage();  // page vide : sert seulement à analyser le HTML reçu
    const q = new URLSearchParams(Object.entries(arg.query || {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]));
    const e = await this.page.evaluate(PARSE_ENTRY, await this.post(`${arg.url}?${q}`, { form: arg.parameters }));
    if (!e || !e.wsid || !e.chartId || !e.inventory || !e.ivar) throw new Unexpected('page de la billetterie inattendue');
    this.entry = e;
    this.action = e.action.replace(/#.*$/, '');
    this.rootUrl = `${e.ivar}/charts/${e.chartId}/inventories/${e.inventory}/zones/root?inventories=${e.inventory}&contingents=${e.contingents.join(',')}`;
    const r = await this.rq.get(this.rootUrl, { timeout: 15000 });
    if (!r.ok()) throw new Error(`plan : réponse HTTP ${r.status()}`);
    this.root = await r.json();
    if (!this.root || !Array.isArray(this.root.children)) throw new Unexpected('plan inattendu');
    this.openedAt = Date.now();
    return true;
  }

  // Sièges de toutes les zones voulues (pas de plan 3D : aucune zone n'est écartée d'avance)
  zones(rules) { return readZones(this.rq, this.root, this.rootUrl, rules, null); }

  // Envoi 3 : panier. true si le site réserve les sièges (page des coordonnées), false s'il les refuse : la session
  // reste alors utilisable pour d'autres sièges (reusable).
  async select(zone, seats) {
    const e = this.entry, cart = {}, qty = {};
    let total = 0, tax = '';
    this.reusable = false;
    for (const seat of seats) {
      // Tarif tout public proposé par la page, hors prévente (« EARLY ») si possible
      const offered = seat.rates.filter(r => e.rates[r.id]);
      const rate = offered.find(r => !/EARLY/i.test(r.name)) || offered[0];
      const info = rate && e.rates[rate.id];
        if (!info || !seat.uuid) { this.why = 'pas de tarif tout public pour ce siège'; this.reusable = true; return false; }
      seat.tarif = rate.name;
      qty[rate.id] = (qty[rate.id] || 0) + 1; total += info.price; tax = tax || info.tax;
      cart[`S${seat.uuid}_I${e.inventory}_R${rate.id}`] = {
        charts: e.chartId, inventory: { id: e.inventory }, zone: { id: zone.uuid }, category: { id: seat.category }, rate: rate.id, seats: [seat.uuid], manual: true,
        rate_info: { name: rate.name, id: rate.id, description: '', price: info.price, priceText: `${info.price.toFixed(2).replace('.', ',')} €`, min: 0, max: 40, preselectedValue: 0, step: 1, order: 0 },
      };
    }
    const fields = e.fields.map(([k, v]) => {
      const m = k.match(/^quantite_(\d+)$/);
      if (m) return [k, String(qty[m[1]] || 0)];
      if (k === 'chps_spb_amount_total_ttc') return [k, String(total)];
      if (k === 'chps_spb_count_charged_tickets') return [k, String(seats.length)];
      if (k === 'chps_pg_vat_rate_id') return [k, tax];
      return [k, v];
    });
    fields.push(['cart_json', JSON.stringify(cart)]);
    const html = await this.post(this.action, {
      data: new URLSearchParams(fields).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://www.weezevent.com', referer: this.action },
    });
    const f = await this.page.evaluate(PARSE_FORM, html);
    if (f && f.step === 'form') { this.form = f; this.expiresAt = expiryOf(html); return true; }
    if (/ne sont plus disponibles/.test(html)) {
      // Le site renvoie la page du panier de la même session : elle sert aux essais suivants
      const again = await this.page.evaluate(PARSE_ENTRY, html);
      if (again && again.wsid && Object.keys(again.rates).length) {
        this.entry = { ...e, fields: again.fields, wsid: again.wsid, rates: again.rates };
        this.action = again.action.replace(/#.*$/, '');
        this.reusable = true;
      }
      this.why = 'places prises entre-temps';
      return false;
    }
    throw new Unexpected(`réponse inattendue à la réservation (étape ${f ? f.step : 'inconnue'})`);
  }

  // Envois 4 et 5 : coordonnées (blocs des billets et bloc acheteur, conditions générales de vente acceptées, pas
  // d'offres commerciales), puis demande de paiement : { link, expiresAt, total }
  async checkout(buyer) {
    const [jj, mm, aaaa] = (buyer.naissance || '').split('/');
    const unknown = [], fields = [];
    for (const f of this.form.fields) {
      const l = norm(f.label);
      if (f.type === 'hidden') { fields.push([f.name, f.value]); continue; }
      if (f.type === 'checkbox') {
        // Conditions générales : acceptées ; autres cases (offres commerciales) : non cochées, envoyées à 0 comme le site
        fields.push([f.name, f.name === 'accepte_cgv' ? f.value || '1' : '0']);
        continue;
      }
      let v = null;
      if (f.tag === 'SELECT') {
        let o = null;
        if (/_day$/.test(f.name)) o = f.options.find(x => +x.text === +jj);
        else if (/_month$/.test(f.name)) o = f.options.find(x => norm(x.text) === MONTHS[+mm - 1] || +x.value === +mm);
        else if (/_year$/.test(f.name)) o = f.options.find(x => x.text === aaaa);
        else if (/civilit/.test(l)) o = f.options.find(x => (/^m(me|adame)/i.test(buyer.civilite) ? /^mme|madame/i : /^(mr|m)\.?$|monsieur/i).test(x.text));
        else if (!f.required && !/\*/.test(f.label)) { fields.push([f.name, f.value]); continue; }
        v = o ? o.value : null;
      } else {
        v = /confirm/.test(l) && /mail/.test(l) ? buyer.email : f.type === 'email' || /e-?mail/.test(l) ? buyer.email
          : /prenom/.test(l) ? buyer.prenom : /^nom\b/.test(l) ? buyer.nom : /telephone|portable|mobile/.test(l) ? buyer.telephone
          : /adresse/.test(l) ? buyer.adresse : /code postal/.test(l) ? buyer.codePostal : /ville/.test(l) ? buyer.ville : null;
        if (v === null && !f.required && !/\*/.test(f.label)) { fields.push([f.name, f.value]); continue; }
      }
      if (v === null || v === undefined || v === '') unknown.push(f.label || f.name); else fields.push([f.name, v]);
    }
    if (unknown.length) throw new Error(`champ des coordonnées inconnu du bot : ${[...new Set(unknown)].join(', ')}`);
    const multipart = {};
    for (const [k, v] of fields) multipart[k] = v;
    const action = this.form.action.replace(/#.*$/, '');
    const html = await this.post(action, { multipart, headers: { origin: 'https://www.weezevent.com', referer: action } });
    const p = await this.page.evaluate(PARSE_FORM, html).catch(() => null);
    const lyria = (html.match(/id="lyriaPayData"[^>]*data-lyriaurl="([^"]+)"[^>]*data-token="([^"]+)"/) || []);
    if (!lyria[1]) {
      // Page des coordonnées renvoyée avec un message : coordonnées refusées ; autre chose : réponse non reconnue
      const err = ((p && p.step === 'form' && p.text.match(/Veuillez[^.|]*|[^.|]*obligatoire[^.|]*/)) || [''])[0].trim();
      if (err) throw new Error(`coordonnées refusées par le site : ${err}`);
      throw new Unexpected(`réponse inattendue aux coordonnées (étape ${p ? p.step : 'inconnue'})`);
    }
    const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const m = text.match(/TOTAL \(TTC\)\s*([\d\s.,]+?)\s*€/);
    const total = m ? `${m[1].replace(/\s/g, '').replace('.', ',')} €` : null;
    const expiresAt = expiryOf(html);
    // Demande de paiement : renvoie l'identifiant de la page de paiement de la commande
    const r = await this.rq.post(`${lyria[1]}/payments/paymentrequests`, {
      data: JSON.stringify({ request_token: lyria[2] }), timeout: 20000,
      headers: { 'content-type': 'application/json', accept: 'application/json', origin: 'https://www.weezevent.com', referer: 'https://www.weezevent.com/' },
    });
    if (r.status() !== 201 && r.status() !== 200) throw new Unexpected(`demande de paiement : réponse HTTP ${r.status()}`);
    // { id, payment_page_url: « https://payment.weezevent.com », … } : la page de paiement de la commande est <url>/<id>
    const j = await r.json().catch(() => null);
    if (!j || !/^[0-9a-f-]{20,}$/i.test(String(j.id)) || !/^https:\/\/payment\.weezevent\.com\/?$/.test(String(j.payment_page_url))) throw new Unexpected('page de paiement introuvable dans la réponse du site');
    return { link: `${String(j.payment_page_url).replace(/\/$/, '')}/${j.id}?lng=fr_FR`, expiresAt, total };
  }
}

module.exports = { Direct, Gate, Unexpected };
