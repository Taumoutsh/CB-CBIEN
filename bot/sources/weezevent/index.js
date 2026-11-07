// Billetterie Weezevent (Ducs d'Angers) : ce que le bot utilise de cette source.
//   hunt.js  moteur (attente de l'ouverture, règles de choix, réservation, proposition de la page de paiement)
//   shop.js  liste des matchs (API Weezevent) et session d'achat (plan, sièges, sélection, coordonnées, paiement)
const { Hunt } = require('./hunt');
const { listEvents } = require('./shop');
const { when } = require('../../lib/dates');

const label = e => `${e.opponent}${e.competition ? ` (${e.competition})` : ''}`;

module.exports = {
  name: 'Weezevent',
  Hunt,

  // Lien de match accepté par /match (page de la billetterie d'un match)
  ownsUrl: url => /^https:\/\/www\.weezevent\.com\/widget_billeterie\.php\?.*id_evenement=\d+/.test(url),
  nameFromUrl: url => `match ${(url.match(/id_evenement=(\d+)/) || [])[1] || ''}`.trim(),
  // Coordonnées de l'acheteur manquantes (le bot les remplit : le site y envoie les billets)
  missingSettings: club => Object.entries(club.buyerEnv).filter(([, k]) => !process.env[k]).map(([, k]) => k),

  // Matchs dont la vente est ouverte : [{ label, date, team, url }]
  async onSale(club, page) {
    const events = await listEvents(page.request, club.widgets);
    return events.filter(e => e.saleStart && e.saleStart <= Date.now())
      .map(e => ({ label: `${label(e)} · ${when(e.at)}`, date: e.date, team: e.opponent, url: e.url }));
  },

  // Matchs publiés, avec l'ouverture de leur vente (donnée par Weezevent) :
  // { items: [{ at, date, opponent, team, url, opening, onSale }], warning }
  async calendar(club, page) {
    const events = await listEvents(page.request, club.widgets);
    return {
      items: events.map(e => ({ at: e.at, date: e.date, opponent: label(e), team: e.opponent, url: e.url, opening: e.saleStart, onSale: !!e.saleStart && e.saleStart <= Date.now() })),
      warning: null,
    };
  },
};
