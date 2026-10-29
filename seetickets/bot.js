// Bot Telegram : programme la recherche de places d'un match et propose les places trouvées (Garder / Refuser).
// Commandes : /match <lien> <ouverture> [places], /statut, /annuler, /favori, /aide.
// N'obéit qu'au chat TELEGRAM_CHAT_ID. Le match programmé est conservé dans DATA_DIR (reprise après redémarrage).
const fs = require('fs'), path = require('path');
const tg = require('./telegram');
const { Hunt, CONFIG, parseOpening, fmtParis } = require('./hunt');
const { eventId } = require('./common');
const { BOOKMARKLET } = require('./handover');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'match.json');
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);
const hhmm = t => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(t);

let hunt = null, match = null, proposal = null;

const saveMatch = m => { fs.mkdirSync(DATA_DIR, { recursive: true }); if (m) fs.writeFileSync(STATE_FILE, JSON.stringify(m)); else fs.rmSync(STATE_FILE, { force: true }); };
const loadMatch = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; } };

// Nom lisible du match à partir du lien (« dijon-sport-espace-… » → « Dijon »)
const matchName = url => {
  const slug = (url.match(/seetickets\.fr\/([^/]+?)-(?:sport-)?espace-/) || url.match(/seetickets\.fr\/([^/-]+)/) || [0, 'match'])[1];
  return slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
};

const HELP = `Commandes :
/match <lien Seetickets> <ouverture> [places]
   ouverture : « 01/12 15:00 », « 15:00 » ou « maintenant » (heure de Paris) ; places : 2 par défaut
/statut : où en est la recherche
/annuler : arrête la recherche en cours
/favori : le favori à installer pour récupérer un panier

Règles : tribunes ${CONFIG.tribunes.join(' > ')} ; ${Math.round(CONFIG.milieu * 100)} % central ; rangs jusqu'à ${Math.round(CONFIG.hauteur * 100)} % de la hauteur ; bancs uniquement (niveaux 3/4 d'abord, puis les autres du plus cher au moins cher), jamais de VIP.`;

// Proposition de places : message avec boutons, code, puis image en arrière-plan.
// Se résout avec 'keep', 'refuse', 'expired' (panier expiré sans réponse) ou 'cancel'.
async function propose(p) {
  const id = Date.now().toString(36);
  const head = `🎟 ${match.places} places au panier — ${matchName(match.url)}\n${p.desc}\n${p.timing}\nPanier valable jusqu'à ${hhmm(p.expiresAt)}.`;
  const msg = await tg.send(`${head}\n\nPour payer : sur billetterie.seetickets.fr, lancer le favori « Panier Seetickets » et coller le code du message suivant.`,
    { buttons: [[{ text: '✅ Garder', data: `keep:${id}` }, { text: '❌ Refuser, chercher d\'autres', data: `refuse:${id}` }]] });
  await tg.send(p.code);
  // L'image ne retarde ni la proposition ni le code
  p.image().then(async file => { await tg.sendPhoto(file, `${p.desc}\n${p.timing}`); fs.unlink(file, () => {}); })
    .catch(e => log('image :', e.message.split('\n')[0]));
  const decision = await new Promise(resolve => {
    const timer = setTimeout(() => done('expired'), Math.max(0, p.expiresAt - Date.now()));
    function done(d) { clearTimeout(timer); proposal = null; resolve(d); }
    proposal = { id, done, head };
  });
  const outcome = {
    keep: `✅ Places gardées : paie avant ${hhmm(p.expiresAt)} avec le code. Recherche terminée.`,
    refuse: '❌ Places refusées : panier vidé, je cherche d\'autres places.',
    expired: '⌛ Panier expiré sans réponse : je reprends la recherche.',
    cancel: '⏹ Recherche annulée (le panier reste valable jusqu\'à son expiration).',
  }[decision];
  if (msg) await tg.edit(msg.message_id, `${head}\n\n${outcome}`);
  else await tg.send(outcome);
  log('Proposition :', decision);
  return decision;
}

async function startHunt(m, resumed = false) {
  match = m;
  saveMatch(m);
  const openAt = new Date(m.openAt);
  hunt = new Hunt({
    url: m.url, openAt: openAt.getTime(), places: m.places,
    events: { info: t => tg.send(t), proposal: propose },
  });
  const current = hunt;
  if (!resumed) await tg.send(`👍 ${matchName(m.url)} : ${m.places} places, ouverture ${openAt <= Date.now() ? 'immédiate' : fmtParis(openAt)}.\nJe me connecte ${Math.round(CONFIG.prepMs / 60000)} min avant l'ouverture. /statut pour suivre, /annuler pour arrêter.`);
  log('Recherche :', m.url, 'ouverture', openAt.toISOString(), m.places, 'places');
  let result;
  try { result = await current.run(); } catch (e) { result = 'error'; log('erreur :', e.stack); await tg.send(`⚠️ Erreur : ${e.message.split('\n')[0]}`); }
  if (hunt !== current) return;  // remplacée entre-temps
  hunt = null;
  if (result === 'error' && match) {
    // Erreur inattendue : nouvel essai, le match reste programmé
    await tg.send('🔁 Nouvel essai dans 30 s.');
    setTimeout(() => { if (match && !hunt) startHunt(match, true); }, 30000);
    return;
  }
  match = null; saveMatch(null);
  if (result === 'kept') await tg.send('🏁 Recherche terminée. Bon match !');
  else if (result === 'cancelled') await tg.send('⏹ Recherche arrêtée.');
}

function status() {
  if (!hunt) return 'Aucune recherche en cours. /match pour en programmer une.';
  const s = hunt.state, open = new Date(match.openAt);
  const when = open > Date.now() ? `ouverture ${fmtParis(open)}` : 'vente ouverte';
  const phases = {
    attente: `⏳ En attente (${when}).`,
    'préparation': '🔐 Connexion et ouverture des plans…',
    ouverture: `🚪 Attente de la mise en vente (${when}).`,
    recherche: `🔎 Recherche en cours : ${s.detail}.`,
    proposition: `🎟 Places proposées : ${s.detail}. Réponds avec les boutons.`,
    'terminé': `✅ Terminé : ${s.detail}.`,
  };
  const refused = hunt.refused.size ? `\n${hunt.refused.size} place(s) refusée(s) écartée(s).` : '';
  return `${matchName(match.url)} — ${match.places} places\n${phases[s.phase] || s.phase}${refused}`;
}

async function onCommand(text) {
  const [cmd, ...args] = text.trim().split(/\s+/);
  switch (cmd.replace(/@.*/, '').toLowerCase()) {
    case '/start': case '/aide': case '/help': return tg.send(HELP);
    case '/favori': return tg.send(`Favori « Panier Seetickets » (à créer une fois, adresse ci-dessous) :\n\n${BOOKMARKLET}`);
    case '/statut': case '/status': return tg.send(status());
    case '/annuler': case '/stop': {
      if (!hunt) return tg.send('Aucune recherche en cours.');
      hunt.cancel();
      if (proposal) proposal.done('cancel');
      return;
    }
    case '/match': {
      if (hunt) return tg.send('Une recherche est déjà en cours (/statut). /annuler d\'abord pour en lancer une autre.');
      const url = args.shift();
      let places = 2;
      if (args.length && /^\d+$/.test(args[args.length - 1]) && args.length > 1 && !/[:h/]/.test(args[args.length - 1])) places = +args.pop();
      const when = args.length ? parseOpening(args.join(' ')) : null;
      try { eventId(url || ''); } catch (e) { return tg.send(`Lien invalide. Exemple :\n/match https://billetterie.seetickets.fr/…-ri11939139.html 01/12 15:00`); }
      if (!when) return tg.send('Heure d\'ouverture invalide : « 01/12 15:00 », « 15:00 » ou « maintenant ».');
      if (places < 1 || places > 8) return tg.send('Nombre de places entre 1 et 8.');
      startHunt({ url, openAt: when.toISOString(), places });
      return;
    }
    default: return tg.send(`Commande inconnue.\n\n${HELP}`);
  }
}

async function onCallback(cb) {
  const [action, id] = String(cb.data || '').split(':');
  if (!proposal || proposal.id !== id) return tg.answerCallback(cb.id, 'Proposition expirée');
  await tg.answerCallback(cb.id, action === 'keep' ? 'Places gardées' : 'Recherche relancée');
  proposal.done(action === 'keep' ? 'keep' : 'refuse');
}

async function main() {
  for (const k of ['SEETICKETS_EMAIL', 'SEETICKETS_PASSWORD', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'])
    if (!process.env[k]) { console.error(`Variable ${k} manquante`); process.exit(1); }
  // Messages arrivés pendant l'arrêt du bot ignorés : pas de commande rejouée par surprise
  let offset = 0;
  const pending = await tg.getUpdates(-1, 0);
  if (pending.ok && pending.result.length) offset = pending.result[pending.result.length - 1].update_id + 1;
  const saved = loadMatch();
  if (saved) {
    await tg.send(`🔄 Bot redémarré : reprise de la recherche ${matchName(saved.url)} (ouverture ${fmtParis(new Date(saved.openAt))}).`);
    startHunt(saved, true);
  } else await tg.send(`🤖 Bot prêt.\n\n${HELP}`);
  log('Bot démarré');
  for (;;) {
    const r = await tg.getUpdates(offset, 25);
    if (!r.ok) { log('getUpdates :', r.description); await new Promise(res => setTimeout(res, 5000)); continue; }
    for (const u of r.result) {
      offset = u.update_id + 1;
      const chat = (u.message && u.message.chat.id) || (u.callback_query && u.callback_query.message && u.callback_query.message.chat.id);
      if (String(chat) !== String(tg.chatId())) { log('Message ignoré (autre chat)'); continue; }
      try {
        if (u.message && u.message.text) await onCommand(u.message.text);
        else if (u.callback_query) await onCallback(u.callback_query);
      } catch (e) { log('traitement :', e.stack); }
    }
  }
}

if (require.main === module) main();
module.exports = { onCommand, status };
