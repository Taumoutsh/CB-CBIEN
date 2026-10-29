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
javascript:(()=>{const c=prompt('Code Seetickets');if(!c)return;atob(c.replace(/\s/g,'')).split(';').forEach(kv=>{['','; domain=.seetickets.fr','; domain=billetterie.seetickets.fr'].forEach(d=>{document.cookie=kv+'; path=/; secure'+d})});location.href='https://billetterie.seetickets.fr/commander-css5-choletbasket-pg201.html'})()
```

À la réception du code :
1. Copier le code reçu sur Telegram.
2. Ouvrir une page de `billetterie.seetickets.fr` (de préférence dans un onglet de navigation privée).
3. Lancer le favori (sur mobile Chrome : taper « Panier Seetickets » dans la barre d'adresse et choisir le favori),
   coller le code : la page de commande s'ouvre avec les places, connecté au compte. Payer avant la fin du délai.

Sur ordinateur, on peut aussi coller le contenu du favori, sans le préfixe `javascript:`, dans la console (F12)
d'une page `billetterie.seetickets.fr`, puis coller le code quand il est demandé.
