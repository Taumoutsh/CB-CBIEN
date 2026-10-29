# Réservation Seetickets — Cholet / Dijon (07/11/2026)

`node reserve.js [--dry-run] [--max-minutes=N] [--places=2]`

Variables d'environnement : `SEETICKETS_EMAIL`, `SEETICKETS_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
(le bot doit avoir reçu `/start` depuis le compte Telegram visé).

Le script met les places au panier, **sans jamais payer**. Le panier est lié à la session du navigateur
du script, pas au compte : pour le récupérer, le script envoie sur Telegram un message de résumé puis un
**code** (à garder privé : il donne accès à la session connectée pendant la durée du panier).

## Récupérer le panier

À faire une fois : créer un favori nommé « Panier Seetickets » avec comme adresse :

```
javascript:(()=>{const c=prompt('Code Seetickets');if(!c)return;atob(c.trim()).split(';').forEach(kv=>{document.cookie=kv+'; path=/; secure'+(kv.startsWith('web_billetterie')?'; domain=.seetickets.fr':'')});location.href='https://billetterie.seetickets.fr/commander-css5-choletbasket-pg201.html'})()
```

À la réception du code :
1. Copier le code reçu sur Telegram.
2. Ouvrir n'importe quelle page de `billetterie.seetickets.fr`.
3. Lancer le favori (sur mobile Chrome : taper « Panier Seetickets » dans la barre d'adresse et choisir le favori),
   coller le code : la page de commande s'ouvre avec les places, connecté au compte. Payer avant la fin du délai.

Sur ordinateur, on peut aussi coller dans la console (F12) de la page `billetterie.seetickets.fr` :
`prompt` → remplacer par le code, c.-à-d. exécuter le contenu du favori sans le préfixe `javascript:`.
