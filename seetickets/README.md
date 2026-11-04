# Bot Telegram de réservation Seetickets — Cholet Basket

Le bot surveille la billetterie d'un match, met au panier les meilleures places conformes dès qu'elles sont
disponibles et te les propose sur Telegram (**Garder** / **Refuser**). Il ne paie jamais : tu récupères le panier
sur ton téléphone et tu paies toi-même.

## Installation (Docker)

```sh
cp .env.example .env        # puis compléter les 2 variables Telegram
docker compose up -d --build
docker compose logs -f      # journal
```

- Aucun identifiant Seetickets : le bot réserve sans se connecter (testé : le panier est conservé quand on se
  connecte ensuite sur le téléphone, au moment de payer).
- `TELEGRAM_BOT_TOKEN` : jeton du bot (BotFather). `TELEGRAM_CHAT_ID` : ton identifiant de chat ;
  le bot n'obéit qu'à ce chat. Envoyer `/start` au bot une fois avant le premier lancement.
- Les matchs programmés sont conservés dans le volume `/data` : après un redémarrage, les recherches reprennent.
- Une seule instance du bot à la fois par jeton Telegram.

## Commandes Telegram

Les commandes sont aussi listées dans le menu de Telegram (bouton « / » ou « Menu » du chat).

| Commande | Effet |
|---|---|
| `/calendrier` | **Matchs à domicile à venir** (championnat et Ligue des champions, d'après le calendrier du site du club) avec **l'ouverture de leur billetterie** (lue sur la bannière de la billetterie), un bouton par match : un clic programme la recherche à l'ouverture (2 places ; tout de suite si la billetterie est déjà ouverte). |
| `/matchs` | Matchs **en vente** sur la billetterie, avec un bouton par match pour le programmer en un clic (2 places, recherche immédiate). Les matchs pas encore en vente n'apparaissent pas sur la billetterie : utiliser `/match`. |
| `/match <adversaire> <ouverture> [places]` | Programme l'ouverture de la billetterie d'un match : à l'heure dite, le bot cherche sur la page d'accueil de la billetterie le match contre cet adversaire et clique sur « Réserver ». Adversaire : tel qu'écrit sur la bannière (`Bourg`, `Saint Quentin`, `Le Mans`… ; majuscules, accents, tirets et « St » indifférents ; seul le nom de l'adversaire du bloc est comparé, pas la salle). Ouverture : `01/12 15:00`, `15:00` ou `maintenant` (heure de Paris). 2 places par défaut. La date du match (`22 octobre 2026`) ou un lien de match direct sont aussi acceptés à la place de l'adversaire. |
| `/statut` | Matchs programmés, état de chaque recherche, bouton 🗑 pour supprimer. |
| `/supprimer [n°]` | Supprime un match programmé (sans n° : liste avec boutons). Un panier déjà proposé reste valable jusqu'à son expiration. |
| `/favori` | Le favori à installer pour récupérer un panier. |
| `/aide` | Rappel des commandes et des règles. |

Exemple : `/match Bourg 01/12 15:00` (billetterie du match contre Bourg ouverte le 1er décembre à 15 h, d'après la bannière de la billetterie). S'il y a plusieurs matchs contre le même adversaire sur la billetterie, le premier de la page est pris (et signalé).

**Plusieurs matchs** peuvent être programmés en même temps (numérotés n°1, n°2…) : chacun a sa propre recherche,
sa propre session et son propre panier, et ses messages sont préfixés par son numéro. Chaque recherche active
utilise son propre navigateur : prévoir de la mémoire sur le VPS si plusieurs recherches tournent ensemble
(un match en attente de son ouverture ne consomme rien).

## Calendrier et ouvertures de billetterie

- Matchs : pages du calendrier du club (`CALENDRIERS`, par défaut championnat et Ligue des champions sur
  cholet-basket.com), matchs **à domicile** seulement.
- Ouvertures : bannière en haut de la page de la billetterie (« Bourg : Mardi 1er décembre à 15h »…), lue par OCR
  (Tesseract, installé dans l'image Docker). L'image n'est relue que lorsqu'elle change (résultat gardé dans
  `/data/banniere.json`) ; l'année est celle de la saison en cours.
- Association : même adversaire (mots communs : « JL Bourg » ↔ « Bourg », « (BCL) » pour la Ligue des champions),
  ouverture la plus proche avant le match. Un match sans ouverture sur la bannière reste programmable avec `/match`.
- À l'ouverture, le match est cherché sur la billetterie par sa date, puis par le nom de l'adversaire.

## Déroulement

1. Attente jusqu'à 3 min avant l'ouverture, puis démarrage du navigateur (sans connexion au compte) et préparation :
   paramètres de la salle lus sur un autre match de la billetterie, cache du navigateur préchauffé sur ce match.
2. Recherche du match sur la page de la billetterie (`BILLETTERIE`, par défaut
   `https://web.digitick.com/index-css5-choletbasketmobile-pg1.html`) : la section du match contre l'adversaire
   saisi (ou à la date saisie) et son bouton « Réserver ». Page relue toutes les 0,5 s à partir de l'heure d'ouverture (≈ 0,15 s par lecture).
3. Deux méthodes démarrent en parallèle, une seule mise au panier à la fois :
   - **requêtes** (rapide) : les requêtes du plan du site appelées directement, sans charger de page
     (≈ 1 s pour lire les 4 tribunes, ≈ 0,6 s par tour, ajout ≈ 1 à 2 s) ;
   - **pages** (secours) : les plans des tribunes ouverts dans le navigateur (≈ 8 à 11 s), la recherche y démarrant
     dès que la tribune préférée est prête.

   La méthode requêtes est utilisée dès qu'elle est prête. Elle est **validée** après un ajout réussi, ou quand les
   deux méthodes voient les mêmes places libres sur 3 tours : la méthode des pages est alors arrêtée. Au moindre
   échec (erreur, réponse inattendue, places différentes de celles du site), un message est envoyé et la méthode
   des pages continue seule (relancée si elle était arrêtée). `METHODE_REQUETES=0` la désactive.
4. Surveillance : rythme rapide (pause 0,5 s) pendant 5 min après l'ouverture et après un refus ; ensuite, quand
   rien ne convient, un tour toutes les 10 s.
5. Dès qu'un groupe convient, ajout au panier, puis sur Telegram : la proposition avec le temps de réservation et
   les boutons, le **code** du panier, la chronologie détaillée (méthode utilisée, durée de chaque étape), puis
   l'image du plan (envoyée en arrière-plan, sans retarder le reste).
6. **Garder** : recherche terminée, paie avant l'expiration du panier (15 min).
   **Refuser** : panier vidé, ces places sont écartées, la recherche reprend aussitôt.
   **Sans réponse** : le panier expire, la recherche reprend.

## Règles de choix des places

- Tribunes par ordre de préférence : Ouest France, Cholet Agglomération, Rehlko, EGDC
  (une tribune absente pour un match est ignorée).
- Zone acceptée : **60 % central** de la tribune (jamais les côtés) et rangs depuis le terrain jusqu'à **80 %**
  de la hauteur (jamais le haut de la tribune).
- Catégories : **bancs uniquement, jamais de VIP** ; niveaux 3/4 bancs d'abord, puis les autres bancs du plus
  cher au moins cher, puis la tribune suivante.
- À catégorie égale : rang le plus proche du terrain, puis tirage au sort (pas de course au plein centre,
  le plus disputé à l'ouverture).
- Réglages dans `.env` : `TRIBUNES`, `MILIEU`, `HAUTEUR`, rythmes (voir `.env.example`).

## Récupérer le panier sur le téléphone

Le bot utilise la version mobile du site : le panier se récupère directement sur iPhone, sans passer en
« site pour ordinateur ». Le panier est lié à la session du bot, pas au compte : le bot envoie un **code**
(à garder privé, il donne accès à la session du panier pendant sa durée).

À faire une fois : créer un favori nommé « Panier Seetickets » avec l'adresse envoyée par `/favori`.
À la réception du code : le copier, ouvrir une page de `billetterie.seetickets.fr`, lancer le favori, coller
le code : la page de commande s'ouvre avec les places ; s'y connecter à son compte (le panier est conservé), puis payer.

## Test sans Telegram

```sh
npm ci && node cli.js --equipe=Dijon --dry-run               # s'arrête avant la validation du panier (ou --date="7 novembre 2026")
node cli.js --date="7 novembre 2026" --decision=refuse,keep   # vrai ajout ; décisions simulées dans l'ordre
```

## Fichiers

- `bot.js` : bot Telegram (commandes, boutons, reprise après redémarrage).
- `hunt.js` : moteur (attente de l'ouverture, règles de choix, deux méthodes, ajout au panier, image du plan).
- `calendar.js` : calendrier du club, lecture (OCR) de la bannière des ouvertures, association.
- `direct.js` : méthode requêtes (plan, places libres, ajout et vidage du panier sans page).
- `common.js` : méthode des pages (tribunes, rafraîchissement, panier).
- `telegram.js` : API Telegram asynchrone. `handover.js` : code et favori de récupération du panier.
- `cli.js` : lancement manuel pour les tests.
