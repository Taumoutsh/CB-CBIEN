// Billetterie Billetweb : liste des matchs et session d'achat, du choix du tarif au lien de paiement.
//
// Parcours d'une commande (testé sur la billetterie du Cholet Hockey) :
//   1. page du match : nombre de places au tarif voulu, puis « Voir le plan » (navigateur : étapes 1 → 4) ;
//   2. sièges pris : une requête (tools.php?avail=0&event=…) donne la liste des sièges déjà réservés ou vendus ;
//   3. sélection : une requête (étape 5) avec les sièges choisis ; le site repasse alors par la page du plan, qui
//      affiche les coordonnées si la sélection est acceptée. Les sièges sont réservés dès ce moment, pendant la durée
//      du panier (≈ 10 min, compte à rebours du site), et refusés à toute autre session ;
//   4. coordonnées de l'acheteur, puis page de paiement : son lien de paiement (lemonway.php?order=…&key=…) ouvre la
//      saisie de carte de cette commande sur n'importe quel appareil, sans cookie.
// Une commande non payée expire d'elle-même et ses sièges sont libérés : le site n'offre pas d'annulation.
const { norm, monthOf, dateOf, parisTime } = require('../../lib/dates');

const ORIGIN = 'https://www.billetweb.fr';

// Date et heure d'un match : « Sam. 07 nov. 2026 de 19h45 à 22h00 » (ou « Sat Nov 07, 2026 from 07:45 PM »)
function parseEventDate(text) {
  const s = norm(text);
  let m = s.match(/(\d{1,2}) ([a-z]+)\.? (\d{4}) (?:de|a) (\d{1,2})h(\d{2})/);
  if (m && monthOf(m[2])) return { date: dateOf(+m[1], monthOf(m[2]), +m[3]), at: parisTime(+m[3], monthOf(m[2]), +m[1], +m[4], +m[5]) };
  m = s.match(/([a-z]{3}) (\d{1,2}), (\d{4}) from (\d{1,2}):(\d{2}) (am|pm)/);
  if (m && monthOf(m[1])) {
    const h = (+m[4] % 12) + (m[6] === 'pm' ? 12 : 0);
    return { date: dateOf(+m[2], monthOf(m[1]), +m[3]), at: parisTime(+m[3], monthOf(m[1]), +m[2], h, +m[5]) };
  }
  return null;
}

// « CHOLET vs ÉPINAL - Championnat » → { opponent: 'ÉPINAL', competition: 'Championnat' }
function parseEventName(name) {
  const m = name.match(/\bvs\.?\s+(.+?)(?:\s+-\s+(.*))?$/i);
  return m ? { opponent: m[1].trim(), competition: (m[2] || '').trim() } : { opponent: name.trim(), competition: '' };
}

// Matchs de la page de la billetterie (multi_event.php) : [{ id, name, opponent, competition, date, at, url }]
async function listEvents(page, listUrl) {
  const html = await (await page.request.get(listUrl, { timeout: 15000 })).text();
  const rows = await page.evaluate(([html, base]) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const t = (e, s) => ((e.querySelector(s) || {}).textContent || '').replace(/\s+/g, ' ').trim();
    return [...doc.querySelectorAll('.multi_event_container')].map(e => {
      const a = e.querySelector('.multi_event_button a[href]');
      return { id: e.id.replace(/\D/g, ''), name: t(e, '.multi_event_name_span'), when: t(e, '.multi_event_date'), url: a ? new URL(a.getAttribute('href'), base).href : null };
    });
  }, [html, listUrl]);
  return rows.map(r => ({ ...r, ...parseEventName(r.name), ...parseEventDate(r.when) })).filter(r => r.url && r.date);
}

// Tarifs de la page d'un match : [{ ticket, name, parent, select, max, cents }] (max = nombre de places proposé)
const READ_TICKETS = html => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('tr.shop_step1_ticket')].map(tr => {
    const sel = tr.querySelector('select[name$="[quantity]"]');
    const price = ((tr.querySelector('.shop_step1_price, [class*=price]') || {}).textContent || '').replace(/\s+/g, ' ');
    const p = price.match(/(\d+)[.,](\d{2})/);
    return {
      ticket: tr.getAttribute('ticket'), name: tr.getAttribute('data-name') || '', parent: tr.getAttribute('data-parent') || '',
      select: sel ? sel.getAttribute('name') : null,
      max: sel ? Math.max(0, ...[...sel.options].map(o => +o.value || 0)) : 0,
      cents: p ? +p[1] * 100 + +p[2] : 0,
    };
  });
};
const findTarif = (tickets, tarif) => tickets.find(t => t.select && norm(t.name) === norm(tarif)) || tickets.find(t => t.select && norm(t.name).includes(norm(tarif)));

// Le tarif est-il en vente pour ce nombre de places ? (simple requête, sans ouvrir la page)
async function onSale(page, url, tarif, places = 1) {
  const html = await (await page.request.get(url, { timeout: 15000 })).text();
  const t = findTarif(await page.evaluate(READ_TICKETS, html), tarif);
  return !!t && t.max >= places && /select_on_map_button/.test(html);
}

// Sièges du plan (données du plan intégrées à la page, en base 64) :
// [{ id, x, y, rang, row (n° du rang dans le plan), num, cat (catégorie), section (bloc : « TRIBUNE MILLET BAS ») }]
function seatsOfMap(map) {
  const cats = Object.fromEntries(map.Categories.list.map(c => [c.key, c.label]));
  const boxes = (map.Components.containers || []).filter(c => c.label && Array.isArray(c.points)).map(c => {
    const xs = c.points.map(p => p.x), ys = c.points.map(p => p.y);
    return { label: c.label, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  });
  const out = [];
  map.Components.rows.forEach((r, ri) => (r.seats || []).forEach(s => {
    const box = boxes.find(b => s.x >= b.x0 && s.x <= b.x1 && s.y >= b.y0 && s.y <= b.y1);
    out.push({ id: s.id, x: s.x, y: s.y, rang: String(r.label), row: ri, num: s.label, cat: cats[s.category] || '', section: box ? box.label : '' });
  }));
  return out;
}

class Session {
  // ctx : contexte navigateur propre à cette commande (sa session) ; url : page du match
  constructor(ctx, url) { this.ctx = ctx; this.url = url; this.page = null; }

  // Étapes 1 → 4 : `places` places au tarif voulu, puis le plan. Renvoie le tarif, ou null s'il n'est pas en vente.
  async start(tarif, places) {
    const p = this.page = this.page || await this.ctx.newPage();
    await p.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const t = findTarif(await p.evaluate(READ_TICKETS, await p.content()), tarif);
    if (!t || t.max < places || !(await p.locator('#select_on_map_button').count())) return null;
    await p.selectOption(`select[name="${t.select}"]`, String(places));
    await Promise.all([p.waitForURL(/step=4/, { timeout: 30000 }), p.click('#select_on_map_button')]);
    await p.waitForLoadState('domcontentloaded');
    const html = await p.content();
    this.sid = (html.match(/data-sid="([0-9a-f]+)"/) || [])[1];
    this.event = (html.match(/tools\.php\?avail=0&event=(\d+)/) || [])[1];
    const sel = (html.match(/encodeURI\('([^']*&step=5)'\)/) || [])[1];
    const b64 = (html.match(/var map_data = Base64\.decode\('([^']+)'\)/) || [])[1];
    if (!this.sid || !this.event || !sel || !b64) throw new Error('page du plan inattendue');
    this.selectUrl = new URL(sel, p.url()).href;
    this.mapUrl = p.url();
    this.seats = seatsOfMap(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')));
    this.tarif = t; this.places = places;
    // Le compte à rebours du panier (≈ 10 min) part de l'ouverture de la session, pas de la réservation des sièges
    this.startedAt = Date.now();
    return t;
  }

  // Sièges déjà pris (réservés dans un panier ou vendus) : Set d'identifiants
  async taken() {
    const r = await this.ctx.request.get(`${ORIGIN}/tools.php?avail=0&event=${this.event}&_=${Date.now()}`, { timeout: 10000 });
    let j;
    try { j = JSON.parse((await r.text()).replace(/^﻿/, '')); } catch (e) { throw new Error('sièges pris : réponse illisible'); }
    if (!j || typeof j.avail !== 'object') throw new Error('sièges pris : réponse inattendue');
    return new Set(Object.keys(j.avail).map(Number));
  }

  // Étape 5 : sélection des sièges. true si le site passe aux coordonnées (sièges réservés pour cette session),
  // false s'il revient au plan (sièges pris entre-temps).
  async select(seats) {
    const data = JSON.stringify(seats.map(s => ({ seat: s.id, capacity: 1, ticket: '' })));
    const r = await this.ctx.request.post(this.selectUrl, {
      data: `&data=${encodeURIComponent(data)}&sid=${this.sid}`, timeout: 15000,
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest', referer: this.mapUrl },
    });
    if (r.status() !== 200) throw new Error(`sélection : réponse HTTP ${r.status()}`);
    // Comme le site : retour à la page du plan, qui passe d'elle-même aux coordonnées si la sélection est acceptée
    await this.page.goto(this.mapUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const ok = await this.page.waitForSelector('#field_1_0_', { timeout: 8000 }).then(() => true, () => false);
    if (ok) {
      // Page des coordonnées entièrement chargée : ses scripts (dont le champ téléphone) sont en place
      await this.page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
      this.expiresAt = await this.basketExpiry();
    }
    return ok;
  }

  // Fin du panier : compte à rebours du site (secondes restantes), 10 min par défaut
  async basketExpiry() {
    const n = ((await this.page.content()).match(/setBasketTimeout\((\d+)\)/) || [])[1];
    return Date.now() + (n ? +n * 1000 : 10 * 60000);
  }

  // Étape « Coordonnées » : remplie avec les coordonnées de l'acheteur (le site y envoie les billets), assurance
  // refusée, pas d'informations commerciales, conditions générales de vente acceptées. Puis la page de paiement :
  // renvoie { link (lien de paiement de la commande), expiresAt }.
  async checkout(buyer) {
    await this.fillBuyer(buyer);
    return this.submitBuyer();
  }

  async fillBuyer(buyer) {
    const p = this.page;
    // Le champ téléphone (indicatif pays) ne valide le numéro qu'une fois son module de validation chargé
    await p.waitForFunction(() => !document.querySelector('[autocomplete$=tel]') || !!window.intlTelInputUtils, null, { timeout: 10000 }).catch(() => {});
    const fields = await p.evaluate(() => [...document.querySelectorAll('input[type=text], input[type=email], input[type=tel]')]
      .filter(i => i.offsetParent && /^field_/.test(i.id))
      .map(i => {
        // Libellé : colonne de gauche de la ligne du formulaire (« Téléphone mobile * »), sinon le texte du parent
        const row = i.closest('tr'), name = row && row.querySelector('.shop_step2_name');
        const label = (name || i.parentElement).textContent.replace(/\s+/g, ' ').trim();
        return { id: i.id, type: i.type, label, required: i.required };
      }));
    const value = f => {
      const l = norm(f.label);
      if (/confirmation/.test(l)) return buyer.email;
      if (f.type === 'email' || /e-?mail/.test(l)) return buyer.email;
      if (/prenom/.test(l)) return buyer.prenom;
      if (/^nom\b/.test(l)) return buyer.nom;
      if (/telephone|portable|mobile/.test(l)) return buyer.telephone;
      if (/code postal/.test(l)) return buyer.codePostal;
      return null;
    };
    for (const f of fields) {
      const v = value(f);
      if (v) { await p.fill(`#${f.id}`, v); await p.locator(`#${f.id}`).blur(); }
      else if (f.required) throw new Error(`champ « ${f.label} » des coordonnées inconnu du bot`);
    }
    await p.evaluate(() => {
      // Questions oui/non (informations commerciales…) : non ; assurance annulation : non
      const groups = {};
      for (const r of document.querySelectorAll('input[type=radio]')) if (r.name && r.name !== 'payment_mode[]') (groups[r.name] = groups[r.name] || []).push(r);
      for (const [name, radios] of Object.entries(groups)) {
        const label = r => ((document.querySelector(`label[for="${r.id}"]`) || r.closest('label') || r.parentElement || {}).textContent || '').trim();
        const no = name === 'insurance' ? radios.find(r => r.value === '0') : radios.find(r => /^non$/i.test(label(r))) || radios.find(r => r.value === '0');
        if (no) no.click();
      }
      const cgv = document.querySelector('#accept_TermsOfSale');
      if (cgv && !cgv.checked) cgv.click();
    });
    const unchecked = await p.evaluate(() => [...document.querySelectorAll('input[type=checkbox][required]')].filter(c => !c.checked).map(c => c.id));
    if (unchecked.length) throw new Error(`case obligatoire inconnue du bot : ${unchecked.join(', ')}`);
  }

  async submitBuyer() {
    const p = this.page;
    await Promise.all([
      p.waitForURL(/step=6/, { timeout: 30000 }).catch(() => {}),
      p.locator('input[type=submit]:visible').last().click(),
    ]);
    await p.waitForLoadState('domcontentloaded');
    const link = await p.locator('[data-pay-url]').first().getAttribute('data-pay-url', { timeout: 5000 }).catch(() => null);
    if (!link) {
      const errors = await p.evaluate(() => [...document.querySelectorAll('.error, label.error, .message_error')].map(e => e.textContent.trim()).filter(Boolean).slice(0, 3).join(' ; '));
      throw new Error(`coordonnées refusées par le site${errors ? ` : ${errors}` : ''}`);
    }
    return { link, expiresAt: await this.basketExpiry() };
  }

  close() { return this.ctx.close().catch(() => {}); }
}

module.exports = { listEvents, onSale, parseEventDate, parseEventName, seatsOfMap, Session };
