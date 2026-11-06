// Reprise du panier sur le téléphone : la session du bot (cookie web_billetterie_*) est passée dans l'adresse de la
// page de commande (?sid=…). Le site adopte alors cette session et le panier reste pour se connecter et payer
// (testé : navigateur neuf, ancienne session, compte connecté, panier précédent déjà repris).
// Version mobile du site : c'est là que le bot crée le panier.
// Le lien donne accès à la session du panier pendant sa durée : à n'envoyer qu'à soi (chat Telegram privé).
const ORDER_URL = 'https://billetterie.seetickets.fr/commander-css5-choletbasketmobile-pg201.html';

async function pickupLink(ctx) {
  const cks = await ctx.cookies('https://billetterie.seetickets.fr/');
  const s = cks.find(c => /^web_billetterie_.*mobile$/.test(c.name)) || cks.find(c => /^web_billetterie_/.test(c.name));
  if (!s) throw new Error('session du panier introuvable');
  return `${ORDER_URL}?sid=${encodeURIComponent(s.value)}`;
}

module.exports = { pickupLink, ORDER_URL };
