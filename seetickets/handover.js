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
// Chaque cookie est posé sous toutes ses formes (hôte seul et domaines) : un ancien cookie du navigateur
// portant le même nom serait sinon envoyé en premier et le serveur garderait la session vide.
const BOOKMARKLET = 'javascript:' + `(()=>{const c=prompt('Code Seetickets');if(!c)return;` +
  `atob(c.replace(/\\s/g,'')).split(';').forEach(kv=>{['','; domain=.seetickets.fr','; domain=billetterie.seetickets.fr'].forEach(d=>{document.cookie=kv+'; path=/; secure'+d})});` +
  `location.href='${ORDER_URL}'})()`;

module.exports = { handoverCode, BOOKMARKLET, ORDER_URL };
