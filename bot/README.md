# Bot Telegram de réservation — Cholet Basket, Cholet Hockey et Ducs d'Angers

Le bot surveille la billetterie d'un match, réserve les meilleures places conformes dès qu'elles sont disponibles et
te les propose sur Telegram (**Garder** / **Refuser**). Il ne paie jamais : tu ouvres le panier ou la page de paiement
sur ton téléphone et tu paies toi-même.

| Club | Billetterie | Ce que le bouton de la proposition ouvre |
|---|---|---|
| 🏀 Cholet Basket | Seetickets | **🎟 Ouvrir le panier** : le panier du bot, se connecter puis payer |
| 🐶 Cholet Hockey | Billetweb | **💳 Payer** : la page de carte bancaire de la commande |
| 🦉 Ducs d'Angers | Weezevent | **💳 Payer** : la page de paiement de la commande |

## Installation (Docker)

```sh
cp .env.example .env        # puis compléter : Telegram, et coordonnées de l'acheteur pour le hockey et Angers
docker compose up -d --build
docker compose logs -f      # journal
```

- `TELEGRAM_BOT_TOKEN` : jeton du bot (BotFather). `TELEGRAM_CHAT_ID` : ton identifiant de chat ; le bot n'obéit
  qu'à ce chat. Envoyer `/start` au bot une fois avant le premier lancement.
- Cholet Basket : aucun identifiant, le bot réserve sans compte (le panier est conservé quand on se connecte sur le
  téléphone, au moment de payer).
- Cholet Hockey : `ACHETEUR_PRENOM`, `ACHETEUR_NOM`, `ACHETEUR_EMAIL`, `ACHETEUR_TELEPHONE`, `ACHETEUR_CODE_POSTAL`.
  Billetweb demande les coordonnées avant le paiement : le bot les remplit, et **les billets sont envoyés à cet email,
  à ce nom**. Sans elles, les commandes du hockey le signalent et ne programment rien.
- Ducs d'Angers : les mêmes, plus `ACHETEUR_ADRESSE`, `ACHETEUR_VILLE`, `ACHETEUR_CIVILITE` (`M.` ou `Mme`) et
  `ACHETEUR_NAISSANCE` (`JJ/MM/AAAA`), demandés par Weezevent à chaque commande. Chaque billet est au nom de
  l'acheteur.
- Les matchs programmés et le nombre de places par défaut sont conservés dans le volume `/data` : après un
  redémarrage, les recherches reprennent.
- Une seule instance du bot à la fois par jeton Telegram.

## Commandes Telegram

Les commandes sont aussi listées dans le menu de Telegram (bouton « / » ou « Menu » du chat). Le club se choisit par
le premier mot (`basket`, `hockey`, `angers`) ; sans club : Cholet Basket. Les matchs sont marqués 🏀, 🐶 ou 🦉.

| Commande | Effet |
|---|---|
| `/calendrier [club]` | Matchs à venir de chaque club, avec l'ouverture de leur billetterie et un bouton ➕ par match (nombre de places par défaut ; recherche tout de suite si la billetterie est ouverte, sinon programmée à l'ouverture). Basket : matchs à domicile du calendrier du club, ouvertures lues sur la bannière de la billetterie. Hockey : matchs publiés sur la billetterie, 🟢 en vente ou ❔ (le club n'annonce pas d'heure d'ouverture : utiliser `/match`). Angers : matchs de la billetterie Weezevent, avec l'ouverture de leur vente donnée par Weezevent. |
| `/matchs [club]` | Matchs **en vente**, un bouton ➕ par match (recherche immédiate). |
| `/match [club] <adversaire> <ouverture> [places]` | Programme l'ouverture de la billetterie d'un match : à l'heure dite, le bot cherche le match sur la billetterie et réserve. Adversaire tel qu'écrit sur la billetterie (`Bourg`, `Saint Quentin`, `Rouen`… ; majuscules, accents, tirets et « St » indifférents). Ouverture : `01/12 15:00`, `15:00` ou `maintenant` (heure de Paris). Places : nombre par défaut si absent. La date du match (`22 octobre 2026`) ou un lien de match (Seetickets, Billetweb ou Weezevent, le club est reconnu) sont aussi acceptés. |
| `/essai [club] <adversaire ou date> [places]` | **Essai à blanc** : le bot fait tout le parcours (match, session, lecture des places, choix) et s'arrête juste avant de réserver. Réponse : places libres et conformes, places choisies avec tarif et prix, temps, puis le plan du bloc et la place dans la salle. Sinon la raison : match introuvable, pas encore en vente, aucune place conforme. Un essai à la fois, arrêté après 15 s sans vente ni place conforme (60 s au plus) ; il attend la fin d'une ouverture en cours et s'arrête si une ouverture commence. Rien n'est réservé ni enregistré. |
| `/statut` | Matchs programmés, état de chaque recherche, bouton 🗑 pour supprimer. |
| `/supprimer [n°]` | Supprime un match programmé (sans n° : liste avec boutons). |
| `/places [nombre] [n°]` | Nombre de places **par défaut** (2 au départ) : `/places 4`. Pour un match déjà programmé : `/places 3 2` (3 places pour le n°2), pris en compte dès le tour suivant. |
| `/aide` | Rappel des commandes et des règles. |

Exemples : `/match Bourg 01/12 15:00` (basket), `/match hockey Rouen 24/11 19:00 3`, `/match angers Amiens 20/11 16:00`.

**Plusieurs matchs** peuvent être programmés en même temps, de plusieurs clubs (n°1, n°2…) : chacun a sa propre
recherche, sa propre session et son propre panier. Chaque recherche active utilise son propre navigateur : prévoir de la
mémoire sur le VPS si plusieurs recherches tournent ensemble (un match en attente de son ouverture ne consomme rien).

## Déroulement commun

1. Attente jusqu'à 3 min avant l'ouverture, puis démarrage du navigateur.
2. Recherche du match sur la billetterie du club, par sa date puis par le nom de l'adversaire ; lecture toutes les
   0,5 s à partir de l'heure d'ouverture.
3. Lecture des places libres, choix du meilleur groupe conforme (règles ci-dessous), réservation.
4. Surveillance : rythme rapide (pause 0,5 s) pendant 5 min après l'ouverture et après un refus ; ensuite, quand rien
   ne convient, un tour toutes les 10 s.
5. Proposition sur Telegram : places, temps de réservation, heure d'expiration, boutons **🎟 Ouvrir le panier** ou
   **💳 Payer**, **✅ Garder**, **❌ Refuser**, **⏹ Arrêter**, puis deux images (en arrière-plan) : le plan de la tribune (ou de la zone) et le plan de toute la salle,
   avec la place proposée. Basket : les 4 tribunes placées autour du terrain (Ouest France et Cholet Agglomération sur
   les grands côtés, Rehlko et EGDC aux extrémités) ; hockey : plan complet de la Glisséo ; Angers : toutes les zones
   de la patinoire, la place à sa position approximative dans sa zone.
6. **Garder** : recherche terminée, bouton du panier ou du paiement conservé ; payer avant l'expiration.
   **Refuser** : ces places sont écartées, la recherche reprend aussitôt. **Arrêter** : comme `/supprimer`.
   **Sans réponse** : à l'expiration du panier, les mêmes places sont reprises aussitôt (dès que le site les libère,
   2 min au plus) et proposées de nouveau (« 🔁 reprise 1/4 »), **au plus 4 fois** (`REPRISES_PANIER`, 0 pour
   désactiver). Ensuite, ces places sont écartées pour ce match, pour ne pas les bloquer indéfiniment aux autres
   supporters, et la recherche reprend sur d'autres places. Pas de reprise pour les Ducs d'Angers : Weezevent garde les
   places bien après le compte à rebours sans permettre de le prolonger (essais) ; la recherche reprend aussitôt et les
   mêmes places peuvent revenir quelques minutes plus tard, quand le site les libère.

### 🏀 Cholet Basket (Seetickets)

- Billetterie : `https://web.digitick.com/index-css5-choletbasketmobile-pg1.html` (bouton « Réserver » de chaque match).
- Deux méthodes en parallèle, une seule mise au panier à la fois :
  - **requêtes** (rapide) : les requêtes du plan du site appelées directement (≈ 1 s pour lire les 4 tribunes, ajout
    ≈ 1 à 2 s) ;
  - **pages** (secours) : les plans des tribunes ouverts dans le navigateur (≈ 8 à 11 s).

  La méthode requêtes est **validée** après un ajout réussi, ou quand les deux méthodes voient les mêmes places libres
  sur 3 tours : la méthode des pages est alors arrêtée. Au moindre échec, un message est envoyé et la méthode des pages
  continue seule. `METHODE_REQUETES=0` la désactive.
- Panier valable 15 min. **Refuser** ou **Arrêter** vide le panier : les places sont libérées tout de suite.
- Avant chaque proposition, le bot vérifie que les places sont bien dans le panier de sa session.
- Ouvertures (`/calendrier`) : bannière en haut de la billetterie, lue par OCR (Tesseract) quand l'image change
  (résultat gardé dans `/data/banniere.json`), associée aux matchs à domicile du calendrier du club.

### 🐶 Cholet Hockey (Billetweb)

- Billetterie : `https://www.billetweb.fr/multi_event.php?multi=42133` (tous les matchs à domicile).
- Un tour : liste des sièges déjà pris (une requête, ≈ 0,3 s), choix, sélection des sièges (≈ 1 à 2 s) : les sièges
  sont alors **réservés pour cette commande** et refusés à tout autre acheteur. Le bot remplit ensuite les
  coordonnées (≈ 1,5 s ; assurance annulation refusée, pas d'informations commerciales, conditions générales de vente
  acceptées) et récupère le lien de paiement de la commande.
- Panier valable 10 min (compte à rebours du site). Billetweb ne permet pas d'annuler une commande : après
  **Refuser** ou **Arrêter**, les places restent bloquées jusqu'à cette expiration (l'heure est indiquée), puis sont
  libérées. La recherche suivante se fait dans une nouvelle commande.
- Le lien **💳 Payer** ouvre la saisie de carte de la commande sur n'importe quel appareil, sans connexion.

### 🦉 Ducs d'Angers (Weezevent)

Plan des blocs de l'Angers IceParc, calculé par le bot à chaque lecture d'après le contour des zones du plan Weezevent
(côté de la glace, rangée, écart au milieu de la glace) :

| Côté | Bord de glace | Derrière |
|---|---|---|
| Long côté sud (centrale) | P · O · **N** · M · L | WL · WC · **VC** · VL · U |
| Long côté nord (Confluences) | D · E · **F** · G · H | Q |
| Bout ouest (virage) | C · B · A | X (angle) |
| Bout est (virage) | I · J · K | R (angle) · S · T |

En gras, les blocs face au milieu de la glace. E, F et G (Confluences) sont aujourd'hui des salons VIP vendus par une
autre billetterie : le bot les lit mais n'y trouve aucune place tout public ; s'ils étaient vendus au public, ils
seraient classés comme N, M et O.

- Billetterie : widget Weezevent du club (`ANGERS_BILLETTERIES`) ; chaque match s'ouvre par sa clé `E<n° du match>`.
- Un tour : sièges de chaque zone voulue par l'API du plan (≈ 0,5 s), choix, puis réservation : c'est à l'envoi du
  panier (« SUITE » sur le site) que le site **réserve les sièges**, ou répond qu'ils ne sont plus disponibles. Le bot
  envoie ensuite les coordonnées (un bloc par billet et le bloc acheteur) et demande la page de paiement de la commande.
- Deux méthodes, comme pour le basket :
  - **requêtes** (rapide) : les envois du site faits directement, sans charger la page ni son plan 3D. Session ≈ 2,5 s,
    réservation ≈ 1 s, page de paiement ≈ 1,5 s : environ **4 s** du démarrage à la proposition ;
  - **navigateur** (secours) : la page du site et son plan 3D (zone, siège, tarif, « Ajouter au panier », « SUITE »,
    « Acheter ») : session ≈ 7 s, réservation ≈ 3 s par siège, page de paiement ≈ 5 s.

  Dès que le site répond autrement que prévu à la méthode requêtes (ou après 3 erreurs de suite), le navigateur prend
  le relais pendant 10 min, puis la méthode requêtes est réessayée. `ANGERS_METHODE_REQUETES=0` la désactive.
- Avant l'ouverture, l'API Weezevent donne un ticket de file d'attente avec le compte à rebours : le bot le garde et le
  renouvelle toutes les 15 s comme la page du site restée ouverte, l'envoie à l'heure d'ouverture annoncée, et sonde
  l'entrée à chaque essai à partir de 20 s avant. Si le site met les acheteurs en file d'attente (forte affluence), le
  ticket gardé conserve sa place et le bot attend son tour (cas prévu d'après le code du site, pas encore observé sur
  une ouverture réelle).
- Seuls les lots de places vendus par la billetterie du match sont lus (un bloc peut être « disponible » dans l'API
  pour une autre billetterie, sans être proposé sur le plan du site).
- Particularité : l'API montre encore libres les sièges réservés dans le panier d'un autre acheteur. Un refus du site
  écarte ces sièges pendant 10 min et la recherche continue : dans la même session par requêtes (≈ 1 s), ou dans une
  nouvelle session par navigateur (≈ 7 s pour rouvrir la page).
- **Vente réservée aux membres** : si le formulaire demande un code membre (ou d'adhérent, de licence) à chaque billet,
  le bot ne s'arrête pas. Un message 🔒 le signale une fois, puis la recherche reprend toutes les 10 min
  (`ANGERS_MEMBRES_MIN`) jusqu'à l'ouverture au public (cas d'Angers – Amiens). Les places essayées restent bloquées
  10 min par la commande abandonnée.
- Panier valable 10 min ; après **Refuser** ou **Arrêter**, la commande expire d'elle-même (heure indiquée).
- Le lien **💳 Payer** ouvre la page de paiement de la commande sur n'importe quel appareil, sans connexion.
- **Veille des ventes** : la billetterie ouvre environ 1,5 mois avant chaque match (compte à rebours sur la page
  « Réserver son billet » du site du club, donné par Weezevent). L'API Weezevent est relue toutes les 30 min
  (`VEILLE_VENTES_MIN`) ; message sur Telegram quand une ouverture est **annoncée** ou **modifiée**, ou qu'une vente
  **ouvre sans annonce** (match publié sans date d'ouverture : ses billets sont déjà en vente), avec un bouton ➕ pour
  programmer la recherche à l'heure d'ouverture. Rien pour un match déjà
  programmé, sauf si son ouverture change : la recherche est alors reprogrammée et le message l'indique. État conservé
  dans `/data/ventes.json` (pas de message répété après un redémarrage). `ANGERS_VEILLE=0` la désactive.
  Les réservations sont prioritaires : pendant la phase critique d'une ouverture (démarrage, attente de la mise en
  vente, 5 min de rythme rapide), la veille est reportée.

## Règles de choix des places

| | 🏀 Cholet Basket | 🐶 Cholet Hockey | 🦉 Ducs d'Angers |
|---|---|---|---|
| Tribunes | Ouest France, Cholet Agglomération, Rehlko, EGDC, par ordre de préférence | Millet, Trioworld et Graphic : la tribune principale, le long de la glace, prise comme un tout | zones centrales et Confluences (en face), puis virages (`ANGERS_ZONES`) ; loges, salons et placement debout exclus |
| Zone | 60 % central de la tribune, rangs depuis le terrain jusqu’à 90 % de la hauteur | 60 % central de la tribune principale, rangs depuis la glace jusqu’à 80 % de la hauteur, **sans le rang A** au bord de la glace (`HOCKEY_SANS_PREMIER_RANG`) | toute la zone, **sans le rang au bord de la glace** (`ANGERS_SANS_PREMIER_RANG`) |
| Priorité | **zone de prédilection** comme au hockey (65 % de la largeur et de la hauteur de la zone acceptée), centrée en largeur mais placée **tout en haut** de la zone acceptée, là où sont les bancs (en pratique les rangs I à Z à Ouest France) : dedans, **le plus centré possible** dans la tribune (tirage au sort entre groupes à égale distance de l'axe) ; sinon au plus près, d'abord dans l'axe central, puis sur les côtés (`BASKET_PREDILECTION`, `BASKET_PREDILECTION_HAUT=0` pour la centrer en hauteur) | **zone de prédilection** : rectangle centré dans la zone acceptée, de 65 % de sa largeur et de sa hauteur (en pratique les rangs C à F, au centre), tirage au sort dedans ; sinon au plus près, d'abord dans l'axe central de la tribune (au-dessus ou en dessous), puis sur les côtés (`HOCKEY_PREDILECTION`) | zone préférée, puis catégorie (1, puis 2, puis 3 : du plus cher au moins cher, les virages de catégorie 2 avant ceux de catégorie 3). **Places centrales, vers le milieu de la glace** (`ANGERS_MILIEU_GLACE`) : blocs face au centre (N, et F en face) avec leur zone de prédilection de 65 % ; puis leurs voisins (M et O, E et G), zone de prédilection collée côté centre, la place la plus proche de la ligne médiane d'abord ; puis la rangée de derrière, de la même façon (VC, puis VL et WC). Virages : la zone de prédilection de 65 % de chaque bloc (`ANGERS_PREDILECTION`) |
| Catégories | bancs uniquement, jamais de VIP ; bancs des niveaux 2, 3 et 4 à égalité (le plus centré l'emporte) | tarif plein, places en vente au public (ni PMR, ni réservées, ni invitations) | tarif normal (ou unique), places en vente au public (ni PMR, ni CE, ni adhérents, ni invitations) |

Hockey et Angers : le tirage au sort dans la zone de prédilection évite la course au plein centre, le plus disputé à l'ouverture. Une tribune absente pour un match est
ignorée. Hockey : comme le site, un groupe qui laisserait un siège libre isolé à côté de lui n'est pas choisi. Réglages dans `.env` (voir `.env.example`).

## Test sans Telegram

```sh
npm ci
node cli.js --equipe=Dijon --dry-run                    # basket : s'arrête avant l'ajout au panier
node cli.js --club=hockey --equipe=Rouen --dry-run      # hockey : s'arrête avant la sélection des sièges
node cli.js --club=angers --equipe=Rouen --dry-run      # Angers : s'arrête avant la sélection des sièges
node cli.js --date="7 novembre 2026" --decision=refuse,keep   # vrai ajout ; décisions simulées dans l'ordre
```

## Organisation du code

```
bot.js            bot Telegram : commandes, boutons, programmation et reprise des matchs (tous clubs)
clubs.js          clubs suivis : billetterie, pages lues, règles de choix (réglages de .env)
cli.js            lancement manuel pour les tests
lib/              commun à toutes les billetteries
  engine.js       socle des moteurs (rythmes, attente de l'ouverture, état) et contrat d'un moteur
  seats.js        zone acceptée d'une tribune, image du plan
  dates.js        dates, heures de Paris, noms d'équipes
  browser.js      navigateur (profil iPhone)
  telegram.js     API Telegram asynchrone
sources/          une billetterie par dossier, même interface (sources/index.js)
  seetickets/     Cholet Basket : moteur, méthode requêtes, méthode des pages, lien du panier, calendrier et OCR
  billetweb/      Cholet Hockey : moteur, session d'achat (plan, sièges pris, sélection, coordonnées, lien de paiement)
  weezevent/      Ducs d'Angers : moteur, méthode requêtes (direct.js), session par navigateur (plan 3D, coordonnées, paiement)
```

Ajouter un club sur une billetterie déjà gérée : une entrée dans `clubs.js`. Ajouter une billetterie : un dossier dans
`sources/` avec la même interface.
