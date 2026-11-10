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
      // Largeur centrale acceptée (0,6 = 60 % central) et hauteur maximale depuis le terrain (0,9 = 90 % des rangs)
      milieu: +env('BASKET_MILIEU', env('MILIEU', '0.6')),
      hauteur: +env('BASKET_HAUTEUR', env('HAUTEUR', '0.9')),
      // Zone de prédilection, comme au hockey : 65 % de la largeur et de la hauteur de la zone acceptée, centrée en
      // largeur et placée tout en haut de la zone acceptée (bancs des niveaux 3/4) ; dedans, le plus centré possible
      // dans la tribune ; sinon au plus près, l'axe central de la tribune avant les côtés
      predilection: +env('BASKET_PREDILECTION', '0.65'),
      predilectionHaut: env('BASKET_PREDILECTION_HAUT', '1') !== '0',
      get summary() { return `bancs uniquement (niveaux 3/4 d'abord), jamais de VIP ; zone de prédilection de ${Math.round(this.predilection * 100)} % centrée, en haut de la zone acceptée (le plus centré possible dedans, sinon au plus près : centre puis côtés)`; },
      // Disposition de la salle (plan d'ensemble envoyé avec chaque proposition) : Ouest France et Cholet Agglomération
      // face à face sur les grands côtés, Rehlko et EGDC aux extrémités
      layout: { OUEST: 'haut', AGGLO: 'bas', REHLKO: 'gauche', EGDC: 'droite' },
    },
  },
  {
    id: 'hockey', name: 'Cholet Hockey', emoji: '🐶', aliases: ['hockey', 'ch', 'dogs'],
    source: 'billetweb',
    list: env('HOCKEY_BILLETTERIE', 'https://www.billetweb.fr/multi_event.php?multi=42133'),
    rules: {
      // Blocs de la tribune principale (Graphic, Millet, Trioworld, côte à côte le long de la glace), pris comme un tout :
      // la zone de prédilection décide de la position
      tribunes: list('HOCKEY_TRIBUNES', 'MILLET,TRIOWORLD,GRAPHIC'),
      milieu: +env('HOCKEY_MILIEU', '0.6'),
      hauteur: +env('HOCKEY_HAUTEUR', '0.8'),
      // Zone de prédilection : centrée dans la zone acceptée, 65 % de sa largeur et de sa hauteur (choix au hasard
      // dedans ; sinon au plus près, l'axe central de la tribune avant les côtés)
      predilection: +env('HOCKEY_PREDILECTION', '0.65'),
      tarif: env('HOCKEY_TARIF', 'Plein Tarif'),
      get summary() { return `zone de prédilection centrée de ${Math.round(this.predilection * 100)} % (au hasard dedans, sinon au plus près : centre puis côtés), tarif plein`; },
    },
    // Coordonnées de l'acheteur remplies par le bot : les billets sont envoyés à cet email, à ce nom
    buyerEnv: { prenom: 'ACHETEUR_PRENOM', nom: 'ACHETEUR_NOM', email: 'ACHETEUR_EMAIL', telephone: 'ACHETEUR_TELEPHONE', codePostal: 'ACHETEUR_CODE_POSTAL' },
    buyer() { return Object.fromEntries(Object.entries(this.buyerEnv).map(([k, v]) => [k, process.env[v] || ''])); },
  },
  {
    id: 'angers', name: 'Ducs d\'Angers', emoji: '🦉', aliases: ['angers', 'ducs'],
    source: 'weezevent',
    // Veille des ventes : chaque ouverture annoncée par Weezevent est signalée sur Telegram (environ 1,5 mois avant le
    // match), avec un bouton pour programmer la recherche
    watch: env('ANGERS_VEILLE', '1') !== '0',
    // Billetteries Weezevent du club (clés de widget) : celle des matchs ouverts à tous
    widgets: list('ANGERS_BILLETTERIES', '365a4f66-826e-4b2e-8bd3-9be8935e239d'),
    rules: {
      // Zones de la patinoire (Angers IceParc), par préférence ; loges, salons VIP, placement debout exclus
      zones: list('ANGERS_ZONES', 'CENTRALE,VIRAGE'),
      exclude: list('ANGERS_ZONES_EXCLUES', 'LOGE,SALON,CONFLUENCES,DEBOUT'),
      // Dans chaque zone : largeur, hauteur et zone de prédilection, comme au hockey de Cholet
      milieu: +env('ANGERS_MILIEU', '1'),
      hauteur: +env('ANGERS_HAUTEUR', '1'),
      predilection: +env('ANGERS_PREDILECTION', '0.65'),
      // Tarifs tout public (nom du tarif) ; tarifs réservés écartés
      tarif: env('ANGERS_TARIF', 'TARIF NORMAL|TARIF UNIQUE|PLEIN TARIF'),
      tarifExclu: 'INVITATION|CE ?/ ?CSE|ADH[ÉE]RENT|PMR|PSH|VIP|LOGE|SALON|LICENCI|R[ÉE]SERVATION|MEMBRE|PACK|DEBOUT',
      get summary() { return `zones ${this.zones.join(' > ')}, catégorie 1 > 2 > 3, zone de prédilection centrée de ${Math.round(this.predilection * 100)} % dans chaque zone, tarif normal`; },
    },
    // Weezevent demande en plus l'adresse, la ville, la civilité et la date de naissance de l'acheteur
    buyerEnv: {
      prenom: 'ACHETEUR_PRENOM', nom: 'ACHETEUR_NOM', email: 'ACHETEUR_EMAIL', telephone: 'ACHETEUR_TELEPHONE', codePostal: 'ACHETEUR_CODE_POSTAL',
      adresse: 'ACHETEUR_ADRESSE', ville: 'ACHETEUR_VILLE', civilite: 'ACHETEUR_CIVILITE', naissance: 'ACHETEUR_NAISSANCE',
    },
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
