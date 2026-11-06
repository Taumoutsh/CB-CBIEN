// Clubs suivis par le bot : billetterie (source), pages à lire et règles de choix des places.
// Chaque réglage peut être changé dans .env (nom de la variable entre parenthèses dans .env.example).
// Pour ajouter un club sur une billetterie déjà gérée : une entrée de plus ici, et ses règles.
const { env } = require('./lib/engine');
const sources = require('./sources');

const list = (k, d) => env(k, d).split(',').map(s => s.trim()).filter(Boolean);

const ALL = [
  {
    id: 'basket', name: 'Cholet Basket', emoji: '🏀', aliases: ['basket', 'cb'],
    source: 'seetickets',
    // Page de la billetterie listant les matchs (un bouton « Réserver » par match)
    list: env('BASKET_BILLETTERIE', env('BILLETTERIE', 'https://web.digitick.com/index-css5-choletbasketmobile-pg1.html')),
    // Calendrier du club (matchs à domicile) : championnat et Ligue des champions
    calendars: list('BASKET_CALENDRIERS', env('CALENDRIERS', 'https://www.cholet-basket.com/calendrier,https://www.cholet-basket.com/calendrier/basketball-champions-league')),
    rules: {
      // Tribunes par ordre de préférence (morceau du nom affiché par le site)
      tribunes: list('BASKET_TRIBUNES', env('TRIBUNES', 'OUEST,AGGLO,REHLKO,EGDC')),
      // Largeur centrale acceptée (0,6 = 60 % central) et hauteur maximale depuis le terrain (0,8 = 80 % des rangs)
      milieu: +env('BASKET_MILIEU', env('MILIEU', '0.6')),
      hauteur: +env('BASKET_HAUTEUR', env('HAUTEUR', '0.8')),
      summary: 'bancs uniquement (niveaux 3/4 d\'abord), jamais de VIP',
    },
  },
  {
    id: 'hockey', name: 'Cholet Hockey', emoji: '🏒', aliases: ['hockey', 'ch'],
    source: 'billetweb',
    list: env('HOCKEY_BILLETTERIE', 'https://www.billetweb.fr/multi_event.php?multi=42133'),
    rules: {
      // Blocs de la tribune principale (Graphic, Millet, Trioworld, côte à côte le long de la glace), par préférence
      tribunes: list('HOCKEY_TRIBUNES', 'MILLET,TRIOWORLD,GRAPHIC'),
      milieu: +env('HOCKEY_MILIEU', '0.6'),
      hauteur: +env('HOCKEY_HAUTEUR', '0.8'),
      // haut : moitié haute de la zone d'abord ; bas : rangs les plus proches de la glace d'abord
      priorite: env('HOCKEY_PRIORITE', 'haut').toLowerCase() === 'bas' ? 'bas' : 'haut',
      tarif: env('HOCKEY_TARIF', 'Plein Tarif'),
      get summary() { return `${this.priorite === 'haut' ? 'moitié haute de la zone d\'abord' : 'rangs du bas d\'abord'}, tarif plein`; },
    },
    // Coordonnées de l'acheteur remplies par le bot : les billets sont envoyés à cet email, à ce nom
    buyerEnv: { prenom: 'ACHETEUR_PRENOM', nom: 'ACHETEUR_NOM', email: 'ACHETEUR_EMAIL', telephone: 'ACHETEUR_TELEPHONE', codePostal: 'ACHETEUR_CODE_POSTAL' },
    buyer() { return Object.fromEntries(Object.entries(this.buyerEnv).map(([k, v]) => [k, process.env[v] || ''])); },
  },
];

// Clubs actifs (CLUBS=basket,hockey par défaut) ; le premier est le club par défaut des commandes
const wanted = list('CLUBS', ALL.map(c => c.id).join(','));
const CLUBS = wanted.map(id => ALL.find(c => c.id === id)).filter(Boolean);
if (!CLUBS.length) throw new Error(`CLUBS : aucun club connu (${ALL.map(c => c.id).join(', ')})`);
for (const c of CLUBS) c.src = sources[c.source];

const clubById = id => CLUBS.find(c => c.id === id) || null;
// « hockey », « CH »… → club, ou null
const clubByAlias = word => CLUBS.find(c => c.aliases.includes(String(word || '').toLowerCase())) || null;
const clubOfUrl = url => CLUBS.find(c => c.src.ownsUrl(url)) || null;

module.exports = { CLUBS, clubById, clubByAlias, clubOfUrl };
