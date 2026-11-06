// Billetterie Seetickets (Cholet Basket) : ce que le bot utilise de cette source.
//   hunt.js     moteur (attente de l'ouverture, règles de choix, deux méthodes, ajout au panier)
//   direct.js   méthode requêtes (plan, places libres, ajout et vidage du panier sans page)
//   pages.js    méthode des pages (tribunes, rafraîchissement, panier)
//   handover.js lien de reprise du panier (session dans l'adresse de la page de commande)
//   calendar.js calendrier du club et ouvertures lues sur la bannière de la billetterie (OCR)
const { Hunt, listMatchLinks, matchLabel, matchDateFromText } = require('./hunt');
const cal = require('./calendar');

module.exports = {
  name: 'Seetickets',
  Hunt,

  // Lien de match accepté par /match (page des places)
  ownsUrl: url => /^https:\/\/billetterie\.seetickets\.fr\/.*-ri\d+\.html/.test(url),
  // Nom court d'après le lien : « …/dijon-espace-… » → « Dijon »
  nameFromUrl: url => {
    const slug = (url.match(/seetickets\.fr\/([^/]+?)-(?:sport-)?espace-/) || url.match(/seetickets\.fr\/([^/-]+)/) || [0, 'match'])[1];
    return slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  },
  // Rien à configurer en plus : réservation sans compte
  missingSettings: () => [],

  // Matchs en vente (bouton « Réserver » sur la billetterie) : [{ label, date }]
  async onSale(club, page) {
    const links = await listMatchLinks(page, club.list);
    return links.map(l => ({ label: matchLabel(l.text), date: matchDateFromText(l.text) })).filter(x => x.date);
  },

  // Matchs à domicile à venir avec l'ouverture de leur billetterie :
  // { items: [{ at, date, opponent, team, opening (Date ou null), onSale }], warning }
  async calendar(club, page, dataDir) {
    const matches = await cal.homeMatches(page, club.calendars);
    let banner, warning = null;
    try { banner = await cal.bannerOpenings(page, club.list, dataDir); }
    catch (e) { console.log('bannière :', e.message); warning = '⚠️ Bannière illisible : ouvertures inconnues.'; banner = { openings: [] }; }
    const items = cal.associate(matches, banner.openings).map(m => ({
      at: m.at, date: m.date, opponent: m.opponent + (/champions/i.test(m.competition) ? ' (BCL)' : ''),
      // Sur la billetterie, le match est cherché par sa date, puis par le nom de l'adversaire écrit sur la bannière
      team: m.bannerName || m.opponent,
      opening: m.opening, onSale: !!m.opening && m.opening <= Date.now(),
    }));
    return { items, warning };
  },
};
