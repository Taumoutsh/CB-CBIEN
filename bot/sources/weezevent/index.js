// Billetterie Weezevent (Ducs d'Angers) : ce que le bot utilise de cette source.
//   hunt.js  moteur (attente de l'ouverture, règles de choix, réservation, proposition de la page de paiement)
//   shop.js  liste des matchs (API Weezevent) et session d'achat (plan, sièges, sélection, coordonnées, paiement)
const { Hunt } = require('./hunt');
const { listEvents } = require('./shop');
const { when } = require('../../lib/dates');

const label = e => `${e.opponent}${e.competition ? ` (${e.competition})` : ''}`;
// Vente ouverte : date d'ouverture passée, ou match publié sans date d'ouverture (constaté : billets déjà en vente)
const onSaleNow = e => (e.saleStart ? e.saleStart <= Date.now() : true);

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
    return events.filter(onSaleNow)
      .map(e => ({ label: `${label(e)} · ${when(e.at)}`, date: e.date, team: e.opponent, url: e.url }));
  },

  // Matchs publiés, avec l'ouverture de leur vente (donnée par Weezevent, qui affiche le compte à rebours de la page
  // « Réserver son billet ») : [{ id, at, date, opponent, team, url, opening (Date ou null), onSale }].
  // Simple requête à l'API : sert aussi à la veille des ventes (bot.js).
  async upcoming(club, request) {
    const events = await listEvents(request, club.widgets);
    return events.map(e => ({ id: String(e.id), at: e.at, date: e.date, opponent: label(e), team: e.opponent, url: e.url, opening: e.saleStart, onSale: onSaleNow(e) }));
  },

  // Calendrier : { items, warning }
  async calendar(club, page) { return { items: await this.upcoming(club, page.request), warning: null }; },
};
