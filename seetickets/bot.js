// Bot Telegram : programme la recherche de places de un ou plusieurs matchs et propose les places trouvées
// (Garder / Refuser). Chaque match a sa propre recherche, sa propre session et son propre panier.
// Commandes : /matchs, /match, /statut, /supprimer, /favori, /aide (aussi dans le menu Telegram).
// N'obéit qu'au chat TELEGRAM_CHAT_ID. Les matchs programmés sont conservés dans DATA_DIR (reprise après redémarrage).
const fs = require('fs'), path = require('path');
const tg = require('./telegram');
const { Hunt, CONFIG, parseOpening, parseMatchDate, matchDateFromText, matchLabel, listMatchLinks, fmtParis } = require('./hunt');
const { chromium, CONTEXT_OPTIONS, eventId } = require('./common');
const { BOOKMARKLET } = require('./handover');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'matchs.json');
const OLD_STATE_FILE = path.join(DATA_DIR, 'match.json');  // ancienne version : un seul match
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);
const hhmm = t => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(t);

// Matchs programmés : n° → { m (données conservées), hunt }. Propositions en attente : id → { done, n }.
const entries = new Map();
const proposals = new Map();
let onSale = [];  // dernier résultat de /matchs

const save = () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify([...entries.values()].map(e => e.m)));
};
const load = () => {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* pas encore de fichier */ }
  try { const old = JSON.parse(fs.readFileSync(OLD_STATE_FILE, 'utf8')); fs.rmSync(OLD_STATE_FILE); return [{ ...old, n: 1 }]; } catch { return []; }
};

// Nom lisible du match : celui trouvé sur la billetterie, sinon la date saisie, sinon d'après le lien
const matchName = e => {
  if (e.hunt && e.hunt.matchLabel) return e.hunt.matchLabel;
  if (e.m.label) return e.m.label;
  if (e.m.date) return `match du ${e.m.date.label}`;
  const slug = (e.m.url.match(/seetickets\.fr\/([^/]+?)-(?:sport-)?espace-/) || e.m.url.match(/seetickets\.fr\/([^/-]+)/) || [0, 'match'])[1];
  return slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
};
// Préfixe des messages quand plusieurs matchs sont programmés
const tag = e => `[n°${e.m.n} · ${matchName(e).split(' - ')[0]}] `;

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

// Commandes affichées dans le menu Telegram (« / » et bouton Menu)
const COMMANDS = [
  { command: 'matchs', description: 'Matchs en vente sur la billetterie, à programmer en un clic' },
  { command: 'match', description: 'Programmer un match : /match 22 octobre 2026 01/12 15:00 [places]' },
  { command: 'statut', description: 'Matchs programmés et état des recherches' },
  { command: 'supprimer', description: 'Supprimer un match programmé : /supprimer [n°]' },
  { command: 'favori', description: 'Favori pour récupérer un panier sur le téléphone' },
  { command: 'aide', description: 'Aide et règles de choix des places' },
];

const HELP = `Commandes (aussi dans le menu « / ») :
/matchs : matchs en vente sur la billetterie, à programmer en un clic (recherche immédiate)
/match <date du match> <ouverture> [places] : programmer un match dont la billetterie n'est pas encore ouverte
   ex. : /match 22 octobre 2026 01/12 15:00
   date du match : « 22 octobre 2026 » ou « 22/10/2026 » ; ouverture : « 01/12 15:00 », « 15:00 » ou « maintenant » (heure de Paris) ; places : 2 par défaut
   À l'ouverture, je clique sur « Réserver » du match à cette date sur la billetterie.
/statut : matchs programmés et état des recherches
/supprimer [n°] : supprimer un match programmé (sans n° : liste avec boutons)
/favori : le favori à installer pour récupérer un panier

Plusieurs matchs peuvent être programmés en même temps : chacun a sa recherche et son panier.
Règles : tribunes ${CONFIG.tribunes.join(' > ')} ; ${Math.round(CONFIG.milieu * 100)} % central ; rangs jusqu'à ${Math.round(CONFIG.hauteur * 100)} % de la hauteur ; bancs uniquement (niveaux 3/4 d'abord, puis les autres du plus cher au moins cher), jamais de VIP.`;

// Proposition de places : message avec boutons, code, puis image en arrière-plan.
// Se résout avec 'keep', 'refuse', 'expired' (panier expiré sans réponse) ou 'cancel'.
async function propose(e, p) {
  const id = Date.now().toString(36) + e.m.n;
  const head = `🎟 ${e.m.places} places au panier — n°${e.m.n} · ${matchName(e)}\n${p.desc}\n${p.timing}\nPanier valable jusqu'à ${hhmm(p.expiresAt)}.`;
  const msg = await tg.send(`${head}\n\nPour payer : sur billetterie.seetickets.fr, lancer le favori « Panier Seetickets », coller le code du message suivant, puis te connecter à ton compte sur la page de commande (le panier est conservé).`,
    { buttons: [[{ text: '✅ Garder', data: `keep:${id}` }, { text: '❌ Refuser, chercher d\'autres', data: `refuse:${id}` }]] });
  await tg.send(p.code);
  if (p.chrono) tg.send(p.chrono);
  // L'image ne retarde ni la proposition ni le code
  p.image().then(async file => { await tg.sendPhoto(file, `${p.desc}\n${p.timing}`); fs.unlink(file, () => {}); })
    .catch(err => log('image :', err.message.split('\n')[0]));
  const decision = await new Promise(resolve => {
    const timer = setTimeout(() => done('expired'), Math.max(0, p.expiresAt - Date.now()));
    function done(d) { clearTimeout(timer); proposals.delete(id); resolve(d); }
    proposals.set(id, { done, n: e.m.n });
  });
  const outcome = {
    keep: `✅ Places gardées : paie avant ${hhmm(p.expiresAt)} avec le code. Recherche terminée pour ce match.`,
    refuse: '❌ Places refusées : panier vidé, je cherche d\'autres places.',
    expired: '⌛ Panier expiré sans réponse : je reprends la recherche.',
    cancel: '⏹ Recherche supprimée (le panier reste valable jusqu\'à son expiration).',
  }[decision];
  if (msg) await tg.edit(msg.message_id, `${head}\n\n${outcome}`);
  else await tg.send(outcome);
  log(`n°${e.m.n} proposition :`, decision);
  return decision;
}

// Lance (ou relance) la recherche d'un match programmé
async function run(e, resumed = false) {
  const m = e.m, openAt = new Date(m.openAt);
  const hunt = e.hunt = new Hunt({
    url: m.url, date: m.date, openAt: openAt.getTime(), places: m.places,
    events: { info: t => tg.send(tag(e) + t), proposal: p => propose(e, p) },
  });
  if (!resumed) await tg.send(`👍 n°${m.n} · ${matchName(e)} : ${m.places} places, ouverture ${openAt <= Date.now() ? 'immédiate' : fmtParis(openAt)}.\n` +
    (openAt > Date.now() ? `Je démarre ${Math.round(CONFIG.prepMs / 60000)} min avant l'ouverture` +
      `${m.date ? `, puis je guette le bouton « Réserver » du ${m.date.label} sur la billetterie` : ''}. ` : '') +
    '/statut pour suivre, /supprimer pour arrêter.');
  log(`n°${m.n} recherche :`, m.url || m.date.label, 'ouverture', openAt.toISOString(), m.places, 'places');
  let result;
  try { result = await hunt.run(); } catch (err) { result = 'error'; log(`n°${m.n} erreur :`, err.stack); await tg.send(`${tag(e)}⚠️ Erreur : ${err.message.split('\n')[0]}`); }
  if (entries.get(m.n) !== e || e.hunt !== hunt) return;  // supprimé ou relancé entre-temps
  if (result === 'error') {
    // Erreur inattendue : nouvel essai, le match reste programmé
    await tg.send(`${tag(e)}🔁 Nouvel essai dans 30 s.`);
    setTimeout(() => { if (entries.get(m.n) === e && e.hunt === hunt) run(e, true); }, 30000);
    return;
  }
  entries.delete(m.n); save();
  if (result === 'kept') await tg.send(`${tag(e)}🏁 Recherche terminée. Bon match !`);
  else if (result === 'cancelled') await tg.send(`${tag(e)}⏹ Recherche arrêtée.`);
}

// Ajoute un match programmé ; refuse un doublon (même date ou même lien)
function schedule(m) {
  const key = x => (x.date ? `${x.date.y}-${x.date.m}-${x.date.d}` : x.url);
  const dup = [...entries.values()].find(e => key(e.m) === key(m));
  if (dup) return tg.send(`Ce match est déjà programmé (n°${dup.m.n}). /statut pour le voir.`);
  m.n = Math.max(0, ...entries.keys()) + 1;
  const e = { m, hunt: null };
  entries.set(m.n, e);
  save();
  run(e);
}

// Supprime un match programmé : arrête sa recherche (et une éventuelle proposition en attente)
async function remove(n) {
  const e = entries.get(n);
  if (!e) return tg.send(`Pas de match programmé n°${n}. /statut pour la liste.`);
  entries.delete(n); save();
  if (e.hunt) e.hunt.cancel();
  for (const [id, p] of proposals) if (p.n === n) p.done('cancel');
  return tg.send(`🗑 Match n°${n} supprimé : ${matchName(e)}.`);
}

function entryStatus(e) {
  const s = e.hunt ? e.hunt.state : { phase: 'attente', detail: '' }, open = new Date(e.m.openAt);
  const when = open > Date.now() ? `ouverture ${fmtParis(open)}` : 'vente ouverte';
  const phases = {
    attente: `⏳ En attente (${when}).`,
    'préparation': '🚀 Démarrage du navigateur…',
    ouverture: `🚪 Attente de la mise en vente (${when}).`,
    recherche: `🔎 Recherche en cours : ${s.detail}.`,
    proposition: `🎟 Places proposées : ${s.detail}. Réponds avec les boutons.`,
    'terminé': `✅ Terminé : ${s.detail}.`,
  };
  const refused = e.hunt && e.hunt.refused.size ? ` ${e.hunt.refused.size} place(s) refusée(s) écartée(s).` : '';
  return `n°${e.m.n} · ${matchName(e)} — ${e.m.places} places\n   ${phases[s.phase] || s.phase}${refused}`;
}

// Liste des matchs programmés, avec un bouton de suppression par match
function status() {
  if (!entries.size) return tg.send('Aucun match programmé.\n/matchs pour voir les matchs en vente, /match pour programmer une ouverture.');
  const list = [...entries.values()];
  return tg.send(`Matchs programmés :\n\n${list.map(entryStatus).join('\n\n')}`,
    { buttons: list.map(e => [{ text: `🗑 Supprimer n°${e.m.n} · ${matchName(e).split(' - ')[0]}`, data: `del:${e.m.n}` }]) });
}

// Matchs en vente sur la billetterie (boutons « Réserver » de la page), à programmer en un clic
async function listOnSale() {
  await tg.send('🔎 Lecture de la billetterie…');
  const browser = await chromium.launch();
  let links;
  try {
    const page = await (await browser.newContext(CONTEXT_OPTIONS)).newPage();
    links = await listMatchLinks(page, CONFIG.listUrl);
  } finally { await browser.close(); }
  onSale = links.map(l => ({ label: matchLabel(l.text), date: matchDateFromText(l.text) })).filter(x => x.date);
  if (!onSale.length) return tg.send('Aucun match en vente sur la billetterie pour l\'instant.\nLes matchs n\'y apparaissent qu\'à l\'ouverture de leur billetterie : /match <date> <ouverture> pour la guetter.');
  return tg.send(`Matchs en vente sur la billetterie (${onSale.length}) :\n\n${onSale.map((x, i) => `${i + 1}. ${x.label}`).join('\n')}\n\n` +
    'Un clic programme le match (2 places, recherche immédiate). Pour un autre nombre de places : /match <date> maintenant <places>.\n' +
    'Les matchs pas encore en vente n\'apparaissent pas ici : /match <date> <ouverture> pour guetter leur ouverture.',
  { buttons: onSale.map((x, i) => [{ text: `➕ ${x.label}`, data: `prog:${i}` }]) });
}

async function onCommand(text) {
  const [cmd, ...args] = text.trim().split(/\s+/);
  switch (cmd.replace(/@.*/, '').toLowerCase()) {
    case '/start': case '/aide': case '/help': return tg.send(HELP);
    case '/favori': return tg.send(`Favori « Panier Seetickets » (à créer une fois, adresse ci-dessous) :\n\n${BOOKMARKLET}`);
    case '/matchs': return listOnSale();
    case '/statut': case '/status': return status();
    case '/supprimer': case '/annuler': case '/stop': {
      // Sans n° : liste avec un bouton par match (pas de suppression sans choix explicite)
      if (args[0] && /^\d+$/.test(args[0])) return remove(+args[0]);
      return status();
    }
    case '/match': {
      const c = parseMatchCommand(args);
      if (c.url) { try { eventId(c.url); } catch (e) { return tg.send('Lien de match invalide.'); } }
      else if (!c.date) return tg.send('Date du match invalide. Exemple :\n/match 22 octobre 2026 01/12 15:00\n\nPour un match déjà en vente : /matchs');
      if (!c.openAt) return tg.send('Heure d\'ouverture invalide : « 01/12 15:00 », « 15:00 » ou « maintenant ». Exemple :\n/match 22 octobre 2026 01/12 15:00');
      if (c.places < 1 || c.places > 8) return tg.send('Nombre de places entre 1 et 8.');
      return schedule({ url: c.url, date: c.date, openAt: c.openAt.toISOString(), places: c.places });
    }
    default: return tg.send(`Commande inconnue.\n\n${HELP}`);
  }
}

async function onCallback(cb) {
  const [action, id] = String(cb.data || '').split(':');
  if (action === 'prog') {
    const x = onSale[+id];
    if (!x) return tg.answerCallback(cb.id, 'Liste expirée : relancer /matchs');
    await tg.answerCallback(cb.id, 'Programmation…');
    return schedule({ date: x.date, label: x.label, openAt: new Date().toISOString(), places: 2 });
  }
  if (action === 'del') {
    await tg.answerCallback(cb.id, 'Suppression');
    return remove(+id);
  }
  const p = proposals.get(id);
  if (!p) return tg.answerCallback(cb.id, 'Proposition expirée');
  await tg.answerCallback(cb.id, action === 'keep' ? 'Places gardées' : 'Recherche relancée');
  p.done(action === 'keep' ? 'keep' : 'refuse');
}

async function main() {
  for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'])
    if (!process.env[k]) { console.error(`Variable ${k} manquante`); process.exit(1); }
  // Liste des commandes dans le menu Telegram
  const r0 = await tg.setCommands(COMMANDS);
  if (!r0.ok) log('setMyCommands :', r0.description);
  // Messages arrivés pendant l'arrêt du bot ignorés : pas de commande rejouée par surprise
  let offset = 0;
  const pending = await tg.getUpdates(-1, 0);
  if (pending.ok && pending.result.length) offset = pending.result[pending.result.length - 1].update_id + 1;
  const saved = load();
  for (const m of saved) entries.set(m.n, { m, hunt: null });
  if (saved.length) {
    save();
    await tg.send(`🔄 Bot redémarré : reprise de ${saved.length} recherche(s).\n\n${[...entries.values()].map(e => `n°${e.m.n} · ${matchName(e)} (ouverture ${fmtParis(new Date(e.m.openAt))})`).join('\n')}`);
    for (const e of entries.values()) run(e, true);
  } else await tg.send(`🤖 Bot prêt.\n\n${HELP}`);
  log('Bot démarré');
  for (;;) {
    const r = await tg.getUpdates(offset, 25);
    if (!r.ok) { log('getUpdates :', r.description); await new Promise(res => setTimeout(res, 5000)); continue; }
    for (const u of r.result) {
      offset = u.update_id + 1;
      const chat = (u.message && u.message.chat.id) || (u.callback_query && u.callback_query.message && u.callback_query.message.chat.id);
      if (String(chat) !== String(tg.chatId())) { log('Message ignoré (autre chat)'); continue; }
      // Commandes traitées sans s'attendre (lecture de la billetterie, envois) : le bot reste réactif
      const job = u.message && u.message.text ? onCommand(u.message.text) : u.callback_query ? onCallback(u.callback_query) : null;
      if (job) Promise.resolve(job).catch(e => log('traitement :', e.stack));
    }
  }
}

if (require.main === module) main();
module.exports = { onCommand, onCallback, parseMatchCommand, COMMANDS };
