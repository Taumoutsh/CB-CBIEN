// Transfert du panier vers le navigateur de l'utilisateur.
// Le panier vit dans la session serveur (cookie web_billetterie_*), et le cookie X-Mapping-*
// désigne le serveur qui la détient : copier ces deux cookies suffit à récupérer le panier.
// Le code donne accès à la session connectée : à n'envoyer qu'à soi (chat Telegram privé).
// Page de commande ; « choletbasket » devient « choletbasketmobile » pour un panier créé avec --mobile
const ORDER_URL = 'https://billetterie.seetickets.fr/commander-css5-choletbasket-pg201.html';
// Page d'où lancer le favori : un script ne peut poser des cookies que pour le site de la page ouverte, et le panier
// du bot est celui de la version mobile (testé : depuis web.digitick.com ou en « site pour ordinateur », panier vide)
const PICKUP_PAGE = 'https://billetterie.seetickets.fr/index-css5-choletbasketmobile-pg1.html';

async function handoverCode(ctx) {
  const cks = (await ctx.cookies()).filter(c => /^(web_billetterie|X-Mapping)/.test(c.name));
  return Buffer.from(cks.map(c => `${c.name}=${c.value}`).join(';')).toString('base64');
}

// Lien vers la page de reprise avec le code après « # » : jamais envoyé au serveur, lu par le favori
const pickupUrl = code => `${PICKUP_PAGE}#st=${encodeURIComponent(code)}`;

// Favori à créer une fois dans son navigateur ; à lancer depuis une page billetterie.seetickets.fr.
// Code lu dans le lien (#st=…) s'il y est, sinon demandé. Le code d'un panier mobile contient le cookie de la
// version mobile : le favori ouvre alors sa page de commande.
// Chaque cookie est posé sous toutes ses formes (hôte seul et domaines) : un ancien cookie du navigateur
// portant le même nom serait sinon envoyé en premier et le serveur garderait la session vide.
const BOOKMARKLET = 'javascript:' + `(()=>{const h=(location.hash.match(/st=([^&]+)/)||[])[1];` +
  `const c=h?decodeURIComponent(h):prompt('Code Seetickets');if(!c)return;const s=atob(c.replace(/\\s/g,''));` +
  `s.split(';').forEach(kv=>{['','; domain=.seetickets.fr','; domain=billetterie.seetickets.fr'].forEach(d=>{document.cookie=kv+'; path=/; secure'+d})});` +
  `location.href='${ORDER_URL}'.replace('choletbasket-',s.includes('choletbasketmobile=')?'choletbasketmobile-':'choletbasket-')})()`;

module.exports = { handoverCode, pickupUrl, BOOKMARKLET, ORDER_URL, PICKUP_PAGE };
