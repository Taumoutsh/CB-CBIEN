# Bot Telegram de réservation Seetickets — Cholet Basket

Le bot surveille la billetterie d'un match, met au panier les meilleures places conformes dès qu'elles sont
disponibles et te les propose sur Telegram (**Garder** / **Refuser**). Il ne paie jamais : tu récupères le panier
sur ton téléphone et tu paies toi-même.

## Installation (Docker)

```sh
cp .env.example .env        # puis compléter les 4 variables
docker compose up -d --build
docker compose logs -f      # journal
```

- `SEETICKETS_EMAIL` / `SEETICKETS_PASSWORD` : compte Seetickets.
- `TELEGRAM_BOT_TOKEN` : jeton du bot (BotFather). `TELEGRAM_CHAT_ID` : ton identifiant de chat ;
  le bot n'obéit qu'à ce chat. Envoyer `/start` au bot une fois avant le premier lancement.
- Le match programmé est conservé dans le volume `/data` : après un redémarrage, la recherche reprend.
- Une seule instance du bot à la fois par jeton Telegram.

## Commandes Telegram

| Commande | Effet |
|---|---|
| `/match <lien> <ouverture> [places]` | Programme la recherche. Ouverture : `01/12 15:00`, `15:00` ou `maintenant` (heure de Paris). 2 places par défaut. |
| `/statut` | Où en est la recherche. |
| `/annuler` | Arrête la recherche (un panier déjà proposé reste valable jusqu'à son expiration). |
| `/favori` | Le favori à installer pour récupérer un panier. |
| `/aide` | Rappel des commandes et des règles. |

Exemple : `/match https://billetterie.seetickets.fr/…-css5-choletbasket-pg101-ri11939139.html 01/12 15:00`

## Déroulement

1. Attente jusqu'à 3 min avant l'ouverture, puis connexion et ouverture des plans des tribunes
   (un onglet chacune), réessayée chaque seconde tant que la vente n'est pas visible.
2. Surveillance : seuls les statuts des sièges sont rafraîchis, en parallèle sur toutes les tribunes
   (≈ 1 s par tour). Rythme rapide (pause 0,5 s) pendant 5 min après l'ouverture et après un refus ;
   ensuite, quand rien ne convient, un tour toutes les 10 s.
3. Dès qu'un groupe convient, ajout au panier (≈ 1,5 à 3 s jusqu'à la confirmation du serveur), puis sur Telegram :
   la proposition avec le temps de réservation et les boutons, le **code** du panier, puis l'image du plan
   (envoyée en arrière-plan, sans retarder le reste).
4. **Garder** : recherche terminée, paie avant l'expiration du panier (15 min).
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
(à garder privé, il donne accès à la session connectée pendant la durée du panier).

À faire une fois : créer un favori nommé « Panier Seetickets » avec l'adresse envoyée par `/favori`.
À la réception du code : le copier, ouvrir une page de `billetterie.seetickets.fr`, lancer le favori, coller
le code : la page de commande s'ouvre avec les places, connecté au compte.

## Test sans Telegram

```sh
npm ci && node cli.js <lien> --dry-run              # s'arrête avant la validation du panier
node cli.js <lien> --decision=refuse,keep           # vrai ajout ; décisions simulées dans l'ordre
```

## Fichiers

- `bot.js` : bot Telegram (commandes, boutons, reprise après redémarrage).
- `hunt.js` : moteur (attente de l'ouverture, règles de choix, ajout au panier, image du plan).
- `common.js` : actions sur le site (connexion, tribunes, rafraîchissement, panier).
- `telegram.js` : API Telegram asynchrone. `handover.js` : code et favori de récupération du panier.
- `cli.js` : lancement manuel pour les tests.
