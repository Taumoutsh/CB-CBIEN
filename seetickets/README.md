# Réservation Seetickets — Cholet / Dijon (07/11/2026)

`node reserve.js [--dry-run] [--mobile] [--max-minutes=N] [--places=2] [--interval=ms]`

Fonctionnement rapide : les plans des deux tribunes sont ouverts une fois (un onglet chacun), puis seuls
les statuts des sièges sont rafraîchis, en parallèle, sans recharger la page (≈ 1 s par tour, plus `--interval`,
500 ms par défaut). Dès qu'un groupe convient, l'ajout au panier est confirmé par le serveur en ≈ 1,5 à 3 s, et
la notification Telegram part aussitôt. Un refus (places prises entre-temps) n'interrompt pas la boucle.

Choix des places, dans l'ordre : niveau 3/4 bancs avant niveau 2 ; zone du milieu (`--milieu=0.4` : 40 % central
de la tribune) avant les côtés ; rang le plus proche du terrain ; puis tirage au sort. Pas de préférence pour
le plein centre dans la zone du milieu : c'est là que tout le monde vise à l'ouverture, et un refus coûte ≈ 1,5 s.
Ouest France reste prioritaire sur Cholet Agglomération à niveau égal.

Après une réservation, Telegram reçoit : le résumé avec le temps de réservation (détection → confirmation du
serveur, et depuis le lancement), le code, puis une image du plan de la tribune avec les places réservées en rouge.

Mode par défaut = version **ordinateur** (la plus rapide) : sur téléphone, passer en « Demander le site pour
ordinateur » avant de lancer le favori.

`--mobile` : le script navigue comme un iPhone et crée le panier sur la **version mobile** du site,
qui a son propre panier. À utiliser pour récupérer le panier depuis un téléphone ; sans cette option,
le panier n'est visible que sur la version ordinateur (sur téléphone : « Demander le site pour ordinateur »).

Variables d'environnement : `SEETICKETS_EMAIL`, `SEETICKETS_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
(le bot doit avoir reçu `/start` depuis le compte Telegram visé).

Le script met les places au panier, **sans jamais payer**. Le panier est lié à la session du navigateur
du script, pas au compte : pour le récupérer, le script envoie sur Telegram un message de résumé puis un
**code** (à garder privé : il donne accès à la session connectée pendant la durée du panier).

## Récupérer le panier

À faire une fois : créer un favori nommé « Panier Seetickets » avec comme adresse :

```
javascript:(()=>{const c=prompt('Code Seetickets');if(!c)return;const s=atob(c.replace(/\s/g,''));s.split(';').forEach(kv=>{['','; domain=.seetickets.fr','; domain=billetterie.seetickets.fr'].forEach(d=>{document.cookie=kv+'; path=/; secure'+d})});location.href='https://billetterie.seetickets.fr/commander-css5-choletbasket-pg201.html'.replace('choletbasket-',s.includes('choletbasketmobile=')?'choletbasketmobile-':'choletbasket-')})()
```

À la réception du code :
1. Copier le code reçu sur Telegram.
2. Ouvrir une page de `billetterie.seetickets.fr` (de préférence dans un onglet de navigation privée).
3. Lancer le favori (sur mobile Chrome : taper « Panier Seetickets » dans la barre d'adresse et choisir le favori),
   coller le code : la page de commande (mobile ou ordinateur selon le code) s'ouvre avec les places, connecté au compte. Payer avant la fin du délai.

Sur ordinateur, on peut aussi coller le contenu du favori, sans le préfixe `javascript:`, dans la console (F12)
d'une page `billetterie.seetickets.fr`, puis coller le code quand il est demandé.
