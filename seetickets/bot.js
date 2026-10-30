// Bot Telegram : programme la recherche de places d'un match et propose les places trouvées (Garder / Refuser).
// Commandes : /match <date du match> <ouverture> [places], /statut, /annuler, /favori, /aide.
// À l'ouverture, le bot trouve le match sur la page de la billetterie (bouton « Réserver » de la section à cette date).
// N'obéit qu'au chat TELEGRAM_CHAT_ID. Le match programmé est conservé dans DATA_DIR (reprise après redémarrage).
const fs = require('fs'), path = require('path');
const tg = require('./telegram');
const { Hunt, CONFIG, parseOpening, parseMatchDate, fmtParis } = require('./hunt');
const { eventId } = require('./common');
const { BOOKMARKLET } = require('./handover');
const phone = require('./call');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'match.json');
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);
const hhmm = t => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(t);

let hunt = null, match = null, proposal = null;

const saveMatch = m => { fs.mkdirSync(DATA_DIR, { recursive: true }); if (m) fs.writeFileSync(STATE_FILE, JSON.stringify(m)); else fs.rmSync(STATE_FILE, { force: true }); };
const loadMatch = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; } };

// Nom lisible du match : celui trouvé sur la billetterie, sinon la date saisie, sinon d'après le lien
const matchName = m => {
  if (hunt && hunt.matchLabel) return hunt.matchLabel;
  if (m.date) return `match du ${m.date.label}`;
  const slug = (m.url.match(/seetickets\.fr\/([^/]+?)-(?:sport-)?espace-/) || m.url.match(/seetickets\.fr\/([^/-]+)/) || [0, 'match'])[1];
  return slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
};

// « /match 22 octobre 2026 01/12 15:00 2 » → date du match, ouverture, places (un lien de match est aussi accepté)
function parseMatchCommand(args) {
  const t = [...args];
  let places = 2;
  if (/^places?$/i.test(t[t.length - 1] || '')) t.pop();
  if (/^\d$/.test(t[t.length - 1] || '') && t.length > 1) places = +t.pop();
  let opening;
  const last = (t[t.length - 1] || '').toLowerCase();
  if (last === 'maintenant' || last === 'now') opening = t.splice(-1).join(' ');
  else if (/^\d{1,2}[:h]\d{2}$/.test(last)) opening = t.splice(/^\d{1,2}\/\d{1,2}(\/\d{4})?$/.test(t[t.length - 2] || '') && t.length > 2 ? -2 : -1).join(' ');
  const openAt = opening ? parseOpening(opening) : null;
  if (/^https?:/.test(t[0] || '')) return { url: t[0], openAt, places };
  return { date: parseMatchDate(t.join(' ')), openAt, places };
}

const HELP = `Commandes :
/match <date du match> <ouverture> [places]
   ex. : /match 22 octobre 2026 01/12 15:00
   date du match : « 22 octobre 2026 » ou « 22/10/2026 » ; ouverture de la billetterie : « 01/12 15:00 », « 15:00 » ou « maintenant » (heure de Paris) ; places : 2 par défaut
   À l'ouverture, je clique sur « Réserver » du match à cette date sur la billetterie.
/statut : où en est la recherche
/annuler : arrête la recherche en cours
/favori : le favori à installer pour récupérer un panier
/testappel : appel Telegram de test (CallMeBot)

Règles : tribunes ${CONFIG.tribunes.join(' > ')} ; ${Math.round(CONFIG.milieu * 100)} % central ; rangs jusqu'à ${Math.round(CONFIG.hauteur * 100)} % de la hauteur ; bancs uniquement (niveaux 3/4 d'abord, puis les autres du plus cher au moins cher), jamais de VIP.`;

// Proposition de places : message avec boutons, code, puis image en arrière-plan.
// Se résout avec 'keep', 'refuse', 'expired' (panier expiré sans réponse) ou 'cancel'.
async function propose(p) {
  const id = Date.now().toString(36);
  const head = `🎟 ${match.places} places au panier — ${matchName(match)}\n${p.desc}\n${p.timing}\nPanier valable jusqu'à ${hhmm(p.expiresAt)}.`;
  const msg = await tg.send(`${head}\n\nPour payer : sur billetterie.seetickets.fr, lancer le favori « Panier Seetickets », coller le code du message suivant, puis te connecter à ton compte sur la page de commande (le panier est conservé).`,
    { buttons: [[{ text: '✅ Garder', data: `keep:${id}` }, { text: '❌ Refuser, chercher d\'autres', data: `refuse:${id}` }]] });
  // Appel Telegram (CallMeBot), sans attendre : ne retarde pas l'envoi du code. Service gratuit parfois saturé :
  // nouveaux essais espacés, abandonnés si la proposition a déjà reçu une réponse.
  if (phone.configured()) {
    const spoken = p.desc.replace(/ - (\d+),00 €$/, ', $1 euros').replace(/ - /g, ', ').toLowerCase();
    phone.call(`Seetickets : ${match.places} places réservées. ${spoken}. Ouvre Telegram pour les garder.`,
      (n, wait) => log(`Appel : service saturé, nouvel essai n°${n} dans ${wait} s`),
      () => !!proposal && proposal.id === id)
      .then(r => {
        log('Appel :', r.ok ? 'passé' : 'échec', `(${r.tries} essai(s))`, r.detail);
        if (!r.ok && !r.dropped) tg.send(`⚠️ Appel impossible après ${r.tries} essai(s) : ${r.detail}`);
      });
  }
  await tg.send(p.code);
  if (p.chrono) tg.send(p.chrono);
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
    url: m.url, date: m.date, openAt: openAt.getTime(), places: m.places,
    events: { info: t => tg.send(t), proposal: propose },
  });
  const current = hunt;
  if (!resumed) await tg.send(`👍 ${matchName(m)} : ${m.places} places, ouverture ${openAt <= Date.now() ? 'immédiate' : fmtParis(openAt)}.\nJe démarre ${Math.round(CONFIG.prepMs / 60000)} min avant l'ouverture` +
    `${m.date ? `, puis je guette le bouton « Réserver » du ${m.date.label} sur la billetterie` : ''}. /statut pour suivre, /annuler pour arrêter.`);
  log('Recherche :', m.url || m.date.label, 'ouverture', openAt.toISOString(), m.places, 'places');
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
    'préparation': '🚀 Démarrage du navigateur…',
    ouverture: `🚪 Attente de la mise en vente (${when}).`,
    recherche: `🔎 Recherche en cours : ${s.detail}.`,
    proposition: `🎟 Places proposées : ${s.detail}. Réponds avec les boutons.`,
    'terminé': `✅ Terminé : ${s.detail}.`,
  };
  const refused = hunt.refused.size ? `\n${hunt.refused.size} place(s) refusée(s) écartée(s).` : '';
  return `${matchName(match)} — ${match.places} places\n${phases[s.phase] || s.phase}${refused}`;
}

async function onCommand(text) {
  const [cmd, ...args] = text.trim().split(/\s+/);
  switch (cmd.replace(/@.*/, '').toLowerCase()) {
    case '/start': case '/aide': case '/help': return tg.send(HELP);
    case '/testappel': {
      if (!phone.configured()) return tg.send('Appel non configuré : ajouter CALLMEBOT_USER=@ton_pseudo dans .env, puis envoyer /start à @CallMeBot_txtbot.');
      await tg.send('📞 Appel de test en cours…');
      const r = await phone.call('Test du bot Seetickets. Si tu entends ce message, les appels fonctionnent.',
        (n, wait) => tg.send(`⏳ CallMeBot saturé (« too many requests ») : nouvel essai dans ${wait} s.`));
      return tg.send(r.ok ? `✅ Appel lancé (${r.detail})` : `⚠️ Appel impossible après ${r.tries} essai(s) : ${r.detail}`);
    }
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
      const c = parseMatchCommand(args);
      if (c.url) { try { eventId(c.url); } catch (e) { return tg.send('Lien de match invalide.'); } }
      else if (!c.date) return tg.send('Date du match invalide. Exemple :\n/match 22 octobre 2026 01/12 15:00');
      if (!c.openAt) return tg.send('Heure d\'ouverture invalide : « 01/12 15:00 », « 15:00 » ou « maintenant ». Exemple :\n/match 22 octobre 2026 01/12 15:00');
      if (c.places < 1 || c.places > 8) return tg.send('Nombre de places entre 1 et 8.');
      startHunt({ url: c.url, date: c.date, openAt: c.openAt.toISOString(), places: c.places });
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
  for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'])
    if (!process.env[k]) { console.error(`Variable ${k} manquante`); process.exit(1); }
  // Messages arrivés pendant l'arrêt du bot ignorés : pas de commande rejouée par surprise
  let offset = 0;
  const pending = await tg.getUpdates(-1, 0);
  if (pending.ok && pending.result.length) offset = pending.result[pending.result.length - 1].update_id + 1;
  const saved = loadMatch();
  if (saved) {
    await tg.send(`🔄 Bot redémarré : reprise de la recherche, ${matchName(saved)} (ouverture ${fmtParis(new Date(saved.openAt))}).`);
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
module.exports = { onCommand, status, parseMatchCommand };
