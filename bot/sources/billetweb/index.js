// Billetterie Billetweb (Cholet Hockey) : ce que le bot utilise de cette source.
//   hunt.js  moteur (attente de l'ouverture, règles de choix, réservation, proposition du lien de paiement)
//   shop.js  liste des matchs et session d'achat (tarif, plan, sièges pris, sélection, coordonnées, lien de paiement)
const { Hunt } = require('./hunt');
const { listEvents, onSale } = require('./shop');
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

  // Matchs publiés sur la billetterie (le club n'annonce pas d'heure d'ouverture : en vente ou pas encore) :
  // { items: [{ at, date, opponent, team, url, opening: null, onSale }], warning }
  async calendar(club, page) {
    const events = await listEvents(page, club.list);
    const sale = await Promise.all(events.map(e => onSale(page, e.url, club.rules.tarif).catch(() => false)));
    return {
      items: events.map((e, i) => ({ at: e.at, date: e.date, opponent: `${e.opponent}${e.competition ? ` (${e.competition})` : ''}`, team: e.opponent, url: e.url, opening: null, onSale: sale[i] })),
      warning: null,
    };
  },
};
