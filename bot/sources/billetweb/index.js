// Billetterie Billetweb (Cholet Hockey) : ce que le bot utilise de cette source.
//   hunt.js  moteur (attente de l'ouverture, règles de choix, réservation, proposition du lien de paiement)
//   shop.js  liste des matchs et session d'achat (tarif, plan, sièges pris, sélection, coordonnées, lien de paiement)
const { Hunt } = require('./hunt');
const { listEvents, onSale, eventStatus } = require('./shop');
const { chromium, CONTEXT_OPTIONS } = require('../../lib/browser');
const { when } = require('../../lib/dates');

module.exports = {
  name: 'Billetweb',
  Hunt,

  // Lien de match accepté par /match (page du match)
  ownsUrl: url => /^https:\/\/www\.billetweb\.fr\/shop\.php\?event=/.test(url),
  // Nom court d'après le lien : « …event=cholet-vs-rouen-1-8-cdf… » → « Rouen 1 8 Cdf »
  nameFromUrl: url => {
    const slug = ((url.match(/event=([^&]+)/) || [])[1] || 'match').replace(/^.*?-vs-/, '');
    return slug.split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  },
  // Coordonnées de l'acheteur manquantes (le bot les remplit : le site y envoie les billets)
  missingSettings: club => Object.entries(club.buyerEnv).filter(([, k]) => !process.env[k]).map(([, k]) => k),

  // Matchs en vente (tarif proposé à l'achat) : [{ label, date, team, url }]
  async onSale(club, page) {
    const events = await listEvents(page, club.list);
    const sale = await Promise.all(events.map(e => onSale(page, e.url, club.rules.tarif).catch(() => false)));
    return events.filter((e, i) => sale[i]).map(e => ({ label: `${e.opponent}${e.competition ? ` (${e.competition})` : ''} · ${when(e.at)}`, date: e.date, team: e.opponent, url: e.url }));
  },

  // Matchs publiés sur la billetterie, en vente ou pas encore (ouverture annoncée sur la page du match) :
  // { items: [{ id, at, date, opponent, team, url, opening (Date ou null), onSale }], warning }
  async calendar(club, page) {
    const events = await listEvents(page, club.list);
    const st = await Promise.all(events.map(e => eventStatus(page, e.url, club.rules.tarif).catch(() => ({ onSale: false, opening: null }))));
    return {
      items: events.map((e, i) => ({
        id: e.id || e.url, at: e.at, date: e.date, opponent: `${e.opponent}${e.competition ? ` (${e.competition})` : ''}`, team: e.opponent, url: e.url,
        opening: st[i].opening, onSale: st[i].onSale,
      })),
      warning: null,
    };
  },

  // Veille des ventes : même liste, lue dans un navigateur à part (pages des matchs analysées) ; ouverture annoncée
  // sur la page du match (« Les ventes débuteront le … à 18h00 »)
  async upcoming(club) {
    const browser = await chromium.launch();
    try { return (await this.calendar(club, await (await browser.newContext(CONTEXT_OPTIONS)).newPage())).items; }
    finally { await browser.close().catch(() => {}); }
  },
};
