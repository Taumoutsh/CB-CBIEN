// Transfert du panier vers le navigateur de l'utilisateur.
// Le panier vit dans la session serveur (cookie web_billetterie_*), et le cookie X-Mapping-*
// désigne le serveur qui la détient : copier ces deux cookies suffit à récupérer le panier.
// Le code donne accès à la session connectée : à n'envoyer qu'à soi (chat Telegram privé).
const ORDER_URL = 'https://billetterie.seetickets.fr/commander-css5-choletbasket-pg201.html';

async function handoverCode(ctx) {
  const cks = (await ctx.cookies()).filter(c => /^(web_billetterie|X-Mapping)/.test(c.name));
  return Buffer.from(cks.map(c => `${c.name}=${c.value}`).join(';')).toString('base64');
}

// Favori à créer une fois dans son navigateur ; à lancer depuis une page billetterie.seetickets.fr.
// Mêmes domaines que ceux posés par le serveur, pour écraser les cookies existants sans doublon.
const BOOKMARKLET = 'javascript:' + encodeURIComponent(`(()=>{const c=prompt('Code Seetickets');if(!c)return;` +
  `atob(c.trim()).split(';').forEach(kv=>{document.cookie=kv+'; path=/; secure'+(kv.startsWith('web_billetterie')?'; domain=.seetickets.fr':'')});` +
  `location.href='${ORDER_URL}'})()`);

module.exports = { handoverCode, BOOKMARKLET, ORDER_URL };
