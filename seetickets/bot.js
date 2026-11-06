// Bot Telegram : programme la recherche de places de un ou plusieurs matchs et propose les places trouvées
// (Garder / Refuser). Chaque match a sa propre recherche, sa propre session et son propre panier.
// Commandes : /calendrier, /matchs, /match, /statut, /supprimer, /places, /aide (aussi dans le menu Telegram).
// N'obéit qu'au chat TELEGRAM_CHAT_ID. Les matchs programmés sont conservés dans DATA_DIR (reprise après redémarrage).
// Messages courts : l'essentiel seulement (le détail est dans le journal).
const fs = require('fs'), path = require('path');
const tg = require('./telegram');
const { Hunt, CONFIG, parseOpening, parseMatchDate, matchDateFromText, matchLabel, listMatchLinks } = require('./hunt');
const { chromium, CONTEXT_OPTIONS, eventId } = require('./common');
const cal = require('./calendar');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'matchs.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'reglages.json');
const OLD_STATE_FILE = path.join(DATA_DIR, 'match.json');  // ancienne version : un seul match
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);
const fmt = o => t => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', ...o }).format(t).replace(' ', ' ');
const hhmm = fmt({ hour: '2-digit', minute: '2-digit' });
const when = fmt({ weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });  // « sam. 12/12 18:00 »

// Matchs programmés : n° → { m (données conservées), hunt }. Propositions en attente : id → { done, n }.
const entries = new Map();
const proposals = new Map();
let onSale = [];    // dernier résultat de /matchs
let calendar = [];  // dernier résultat de /calendrier

const save = () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify([...entries.values()].map(e => e.m)));
};
const load = () => {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* pas encore de fichier */ }
  try { const old = JSON.parse(fs.readFileSync(OLD_STATE_FILE, 'utf8')); fs.rmSync(OLD_STATE_FILE); return [{ ...old, n: 1 }]; } catch { return []; }
};

// Réglages conservés : nombre de places par défaut (/places)
const MAX_PLACES = 8;
let settings = { places: 2 };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { /* valeurs par défaut */ }
const saveSettings = () => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); };
const nbPlaces = n => `${n} place${n > 1 ? 's' : ''}`;

// Nom court du match : adversaire (« JL Bourg », « DIJON »), sinon la date saisie, sinon d'après le lien
const shortName = e => {
  const label = (e.hunt && e.hunt.matchLabel) || e.m.label;
  if (label) return label.split(' · ')[0].split(/ (?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche) /i)[0];
  if (e.m.team) return e.m.team;
  if (e.m.date) return e.m.date.label;
  const slug = (e.m.url.match(/seetickets\.fr\/([^/]+?)-(?:sport-)?espace-/) || e.m.url.match(/seetickets\.fr\/([^/-]+)/) || [0, 'match'])[1];
  return slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
};
const tag = e => `n°${e.m.n} ${shortName(e)} · `;
// « TRIBUNE REHLKO - NIVEAU 4 BANCS - rang N places 45, 46 - 36,00 € » → « REHLKO · NIVEAU 4 BANCS · rang N places 45, 46 · 36 € »
const seatsText = desc => desc.replace(/^TRIBUNE /, '').replace(/ - /g, ' · ').replace(/,00 €/, ' €');

// « /match Bourg 01/12 15:00 2 » ou « /match 22 octobre 2026 01/12 15:00 » → adversaire ou date du match, ouverture,
// places (un lien de match est aussi accepté)
function parseMatchCommand(args) {
  const t = [...args];
  let places = null;  // absent : nombre de places par défaut (/places)
  if (/^places?$/i.test(t[t.length - 1] || '')) t.pop();
  if (/^\d$/.test(t[t.length - 1] || '') && t.length > 1) places = +t.pop();
  let opening;
  const last = (t[t.length - 1] || '').toLowerCase();
  if (last === 'maintenant' || last === 'now') opening = t.splice(-1).join(' ');
  else if (/^\d{1,2}[:h]\d{2}$/.test(last)) opening = t.splice(/^\d{1,2}\/\d{1,2}(\/\d{4})?$/.test(t[t.length - 2] || '') && t.length > 2 ? -2 : -1).join(' ');
  const openAt = opening ? parseOpening(opening) : null;
  if (/^https?:/.test(t[0] || '')) return { url: t[0], openAt, places };
  const text = t.join(' ').trim();
  const date = parseMatchDate(text);
  if (date) return { date, openAt, places };
  // Pas une date : nom de l'adversaire, cherché sur la page d'accueil de la billetterie à l'ouverture
  return { team: /[a-zà-ÿ]{2}/i.test(text) ? text : null, openAt, places };
}

// Commandes affichées dans le menu Telegram (« / » et bouton Menu)
const COMMANDS = [
  { command: 'calendrier', description: 'Matchs à domicile et ouvertures de billetterie' },
  { command: 'matchs', description: 'Matchs en vente' },
  { command: 'match', description: 'Programmer : /match Bourg 01/12 15:00 [places]' },
  { command: 'statut', description: 'Matchs programmés' },
  { command: 'supprimer', description: 'Supprimer : /supprimer n°' },
  { command: 'places', description: 'Places par défaut : /places 4 ; d\'un match : /places 3 n°' },
  { command: 'aide', description: 'Aide' },
];

const HELP = `/calendrier — matchs à domicile et ouvertures (➕ pour programmer)
/matchs — matchs en vente (➕ pour programmer)
/match Bourg 01/12 15:00 [places] — programmer une ouverture
/statut — matchs programmés (🗑 pour supprimer)
/supprimer n° — supprimer un match
/places 4 [n°] — places par défaut, ou d'un match

Règles : ${CONFIG.tribunes.join(' > ')} · ${Math.round(CONFIG.milieu * 100)} % central · ${Math.round(CONFIG.hauteur * 100)} % de hauteur · bancs, jamais de VIP.`;

// Proposition de places : message avec boutons (panier, Garder, Refuser), puis image en arrière-plan.
// Se résout avec 'keep', 'refuse', 'expired' (panier expiré sans réponse) ou 'cancel'.
async function propose(e, p) {
  const id = Date.now().toString(36) + e.m.n;
  const head = `🎟 ${tag(e)}${nbPlaces(e.m.places)}\n${seatsText(p.desc)}\n${p.timing} · valable jusqu'à ${hhmm(p.expiresAt)}`;
  // Le lien ouvre la page de commande dans la session du bot (le site l'adopte) : se connecter, puis payer
  const open = [{ text: '🎟 Ouvrir le panier', url: p.link }];
  const msg = await tg.send(head, { buttons: [open, [{ text: '✅ Garder', data: `keep:${id}` }, { text: '❌ Refuser', data: `refuse:${id}` }]] });
  // L'image ne retarde pas la proposition
  p.image().then(async file => { await tg.sendPhoto(file, seatsText(p.desc)); fs.unlink(file, () => {}); })
    .catch(err => log('image :', err.message.split('\n')[0]));
  const decision = await new Promise(resolve => {
    const timer = setTimeout(() => done('expired'), Math.max(0, p.expiresAt - Date.now()));
    function done(d) { clearTimeout(timer); proposals.delete(id); resolve(d); }
    proposals.set(id, { done, n: e.m.n });
  });
  const outcome = {
    keep: `✅ Gardées — paie avant ${hhmm(p.expiresAt)}.`,
    refuse: '❌ Refusées, je cherche d\'autres places.',
    expired: '⌛ Expiré, je reprends.',
    cancel: '⏹ Supprimé.',
  }[decision];
  // Places gardées : le bouton du panier reste, pour payer
  if (msg) await tg.edit(msg.message_id, `${head}\n${outcome}`, { buttons: decision === 'keep' ? [open] : undefined });
  else await tg.send(outcome);
  log(`n°${e.m.n} proposition :`, decision);
  return decision;
}

// Lance (ou relance) la recherche d'un match programmé
async function run(e, resumed = false) {
  const m = e.m, openAt = new Date(m.openAt);
  const hunt = e.hunt = new Hunt({
    url: m.url, date: m.date, team: m.team, openAt: openAt.getTime(), places: m.places,
    events: { info: t => tg.send(tag(e) + t), proposal: p => propose(e, p) },
  });
  if (!resumed) await tg.send(`👍 ${tag(e)}${nbPlaces(m.places)} · ${openAt <= Date.now() ? 'recherche immédiate' : `ouverture ${when(openAt)}`}`);
  log(`n°${m.n} recherche :`, m.url || hunt.target, 'ouverture', openAt.toISOString(), m.places, 'places');
  let result;
  try { result = await hunt.run(); } catch (err) { result = 'error'; log(`n°${m.n} erreur :`, err.stack); }
  if (entries.get(m.n) !== e || e.hunt !== hunt) return;  // supprimé ou relancé entre-temps
  if (result === 'error') {
    // Erreur inattendue : nouvel essai, le match reste programmé
    await tg.send(`${tag(e)}⚠️ Erreur, nouvel essai dans 30 s.`);
    setTimeout(() => { if (entries.get(m.n) === e && e.hunt === hunt) run(e, true); }, 30000);
    return;
  }
  entries.delete(m.n); save();
  if (result === 'cancelled') await tg.send(`${tag(e)}⏹ Arrêté.`);
}

// Ajoute un match programmé ; refuse un doublon (même date ou même adversaire)
function schedule(m) {
  const key = x => (x.date ? `${x.date.y}-${x.date.m}-${x.date.d}` : x.team ? `contre ${x.team.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}` : x.url);
  // Un match programmé par son adversaire seul (/match Bourg …) est le même que celui choisi dans /calendrier
  const sameTeam = (a, b) => a.team && b.team && a.team.toLowerCase() === b.team.toLowerCase();
  const dup = [...entries.values()].find(e => key(e.m) === key(m) || sameTeam(e.m, m));
  if (dup) return tg.send(`Déjà programmé (n°${dup.m.n}).`);
  m.n = Math.max(0, ...entries.keys()) + 1;
  const e = { m, hunt: null };
  entries.set(m.n, e);
  save();
  run(e);
}

// Supprime un match programmé : arrête sa recherche (et une éventuelle proposition en attente)
async function remove(n) {
  const e = entries.get(n);
  if (!e) return tg.send(`Pas de n°${n}.`);
  entries.delete(n); save();
  if (e.hunt) e.hunt.cancel();
  for (const p of proposals.values()) if (p.n === n) p.done('cancel');
  return tg.send(`🗑 n°${n} ${shortName(e)} supprimé.`);
}

function entryStatus(e) {
  const phase = e.hunt ? e.hunt.state.phase : 'attente', open = new Date(e.m.openAt);
  const state = {
    attente: open > Date.now() ? `⏳ ${when(open)}` : '⏳',
    'préparation': '🚀 démarrage',
    ouverture: '🚪 pas encore en vente',
    recherche: '🔎 recherche',
    proposition: '🎟 places proposées',
    'terminé': '✅ terminé',
  }[phase] || phase;
  const refused = e.hunt && e.hunt.refused.size ? ` · ${e.hunt.refused.size} refusée(s)` : '';
  return `n°${e.m.n} ${shortName(e)} · ${nbPlaces(e.m.places)} · ${state}${refused}`;
}

// Liste des matchs programmés, avec un bouton de suppression par match
function status() {
  if (!entries.size) return tg.send('Aucun match programmé. /calendrier pour en ajouter.');
  const list = [...entries.values()];
  return tg.send(list.map(entryStatus).join('\n'), { buttons: list.map(e => [{ text: `🗑 n°${e.m.n} ${shortName(e)}`, data: `del:${e.m.n}` }]) });
}

// Matchs en vente sur la billetterie (boutons « Réserver » de la page), à programmer en un clic
async function listOnSale() {
  const browser = await chromium.launch();
  let links;
  try {
    const page = await (await browser.newContext(CONTEXT_OPTIONS)).newPage();
    links = await listMatchLinks(page, CONFIG.listUrl);
  } finally { await browser.close(); }
  onSale = links.map(l => ({ label: matchLabel(l.text), date: matchDateFromText(l.text) })).filter(x => x.date);
  if (!onSale.length) return tg.send('Aucun match en vente. /calendrier pour les prochaines ouvertures.');
  return tg.send(`En vente (➕ = ${nbPlaces(settings.places)}, recherche immédiate) :`,
    { buttons: onSale.map((x, i) => [{ text: `➕ ${x.label}`, data: `prog:${i}` }]) });
}

// Matchs à domicile à venir (calendrier du club) avec l'ouverture de leur billetterie (bannière lue par OCR)
async function showCalendar() {
  const browser = await chromium.launch();
  let matches, banner, ocrError = null;
  try {
    const page = await (await browser.newContext(CONTEXT_OPTIONS)).newPage();
    matches = await cal.homeMatches(page);
    banner = await cal.bannerOpenings(page, DATA_DIR).catch(e => { ocrError = e.message; log('bannière :', e.message); return { openings: [] }; });
  } finally { await browser.close(); }
  calendar = cal.associate(matches, banner.openings);
  if (!calendar.length) return tg.send('Aucun match à domicile à venir.');
  const scheduled = m => [...entries.values()].find(e => e.m.date && e.m.date.d === m.date.d && e.m.date.m === m.date.m && e.m.date.y === m.date.y);
  const lines = calendar.map(m => {
    const s = scheduled(m);
    const open = !m.opening ? '❔' : m.opening <= Date.now() ? '🟢 en vente' : `🎫 ${when(m.opening)}`;
    return `${when(m.at)} ${m.opponent}${/champions/i.test(m.competition) ? ' (BCL)' : ''}\n   ${open}${s ? ` · ✅ n°${s.m.n}` : ''}`;
  });
  const buttons = calendar.map((m, i) => (m.opening && !scheduled(m) ? [{ text: `➕ ${m.opponent}`, data: `cal:${i}` }] : null)).filter(Boolean);
  return tg.send(`${lines.join('\n')}\n\n🎫 ouverture · ➕ = ${nbPlaces(settings.places)}` + (ocrError ? '\n⚠️ Bannière illisible : ouvertures inconnues.' : ''), { buttons });
}

// /places : voir ou changer le nombre de places par défaut, ou celui d'un match programmé
async function setPlaces(args) {
  if (!args.length) return tg.send(`Par défaut : ${nbPlaces(settings.places)}. /places 4 pour changer, /places 3 n° pour un match.`);
  const n = +args[0];
  if (!/^\d+$/.test(args[0]) || n < 1 || n > MAX_PLACES) return tg.send(`Entre 1 et ${MAX_PLACES} places.`);
  if (args[1]) {
    const e = entries.get(+String(args[1]).replace(/^n°/i, ''));
    if (!e) return tg.send(`Pas de n°${args[1]}.`);
    if (e.hunt && e.hunt.state.phase === 'proposition') return tg.send(`n°${e.m.n} : réponds d'abord à la proposition.`);
    e.m.places = n; save();
    // Recherche en cours : nouveau nombre pris en compte dès le tour suivant
    if (e.hunt) e.hunt.places = n;
    return tg.send(`✅ ${tag(e)}${nbPlaces(n)}`);
  }
  settings.places = n; saveSettings();
  return tg.send(`✅ Par défaut : ${nbPlaces(n)}.`);
}

async function onCommand(text) {
  const [cmd, ...args] = text.trim().split(/\s+/);
  switch (cmd.replace(/@.*/, '').toLowerCase()) {
    case '/start': case '/aide': case '/help': return tg.send(HELP);
    case '/matchs': return listOnSale();
    case '/places': return setPlaces(args);
    case '/calendrier': return showCalendar();
    case '/statut': case '/status': return status();
    case '/supprimer': case '/annuler': case '/stop': {
      // Sans n° : liste avec un bouton par match (pas de suppression sans choix explicite)
      if (args[0] && /^\d+$/.test(args[0])) return remove(+args[0]);
      return status();
    }
    case '/match': {
      const c = parseMatchCommand(args);
      if (c.url) { try { eventId(c.url); } catch (e) { return tg.send('Lien invalide.'); } }
      else if (!c.date && !c.team) return tg.send('Exemple : /match Bourg 01/12 15:00');
      if (!c.openAt) return tg.send('Ouverture invalide. Exemple : /match Bourg 01/12 15:00');
      const places = c.places || settings.places;
      if (places < 1 || places > MAX_PLACES) return tg.send(`Entre 1 et ${MAX_PLACES} places.`);
      return schedule({ url: c.url, date: c.date, team: c.team, openAt: c.openAt.toISOString(), places });
    }
    default: return tg.send('Commande inconnue. /aide');
  }
}

async function onCallback(cb) {
  const [action, id] = String(cb.data || '').split(':');
  if (action === 'prog') {
    const x = onSale[+id];
    if (!x) return tg.answerCallback(cb.id, 'Liste expirée : /matchs');
    await tg.answerCallback(cb.id, 'OK');
    return schedule({ date: x.date, label: x.label, openAt: new Date().toISOString(), places: settings.places });
  }
  if (action === 'cal') {
    const m = calendar[+id];
    if (!m || !m.opening) return tg.answerCallback(cb.id, 'Liste expirée : /calendrier');
    await tg.answerCallback(cb.id, 'OK');
    // Sur la billetterie, le match est cherché par sa date, puis par le nom de l'adversaire écrit sur la bannière
    return schedule({ date: m.date, team: m.bannerName || m.opponent, label: m.opponent,
      openAt: new Date(Math.max(+m.opening, Date.now())).toISOString(), places: settings.places });
  }
  if (action === 'del') {
    await tg.answerCallback(cb.id, 'OK');
    return remove(+id);
  }
  const p = proposals.get(id);
  if (!p) return tg.answerCallback(cb.id, 'Expiré');
  await tg.answerCallback(cb.id, 'OK');
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
    await tg.send(`🔄 Redémarré · ${saved.length} recherche(s) reprise(s).`);
    for (const e of entries.values()) run(e, true);
  } else await tg.send('🤖 Prêt. /aide');
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
