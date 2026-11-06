// Bot Telegram : programme la recherche de places de un ou plusieurs matchs, de un ou plusieurs clubs (clubs.js),
// et propose les places trouvées (Garder / Refuser). Chaque match a sa propre recherche, sa propre session et son
// propre panier ; la billetterie de son club (sources/) fait le reste.
// Commandes : /calendrier, /matchs, /match, /statut, /supprimer, /places, /aide (aussi dans le menu Telegram).
// N'obéit qu'au chat TELEGRAM_CHAT_ID. Les matchs programmés sont conservés dans DATA_DIR (reprise après redémarrage).
// Messages courts : l'essentiel seulement (le détail est dans le journal).
const fs = require('fs'), path = require('path');
const tg = require('./lib/telegram');
const { chromium, CONTEXT_OPTIONS } = require('./lib/browser');
const { parseOpening, parseMatchDate, sameDate, norm, hhmm, when } = require('./lib/dates');
const { CLUBS, clubById, clubByAlias, clubOfUrl } = require('./clubs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'matchs.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'reglages.json');
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);
const MAX_PLACES = 8;

// ─── État : matchs programmés, propositions en attente, réglages ─────────────────────────────────────────────────

// Matchs programmés : n° → { m (données conservées : n, club, url, date, team, label, openAt, places), hunt }
const entries = new Map();
// Propositions en attente de réponse : id → { done, n, released, expiresAt }
const proposals = new Map();
// Derniers résultats de /matchs et /calendrier (les boutons y renvoient par leur rang)
let onSaleList = [], calendarList = [];

const save = () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify([...entries.values()].map(e => e.m)));
};
// Matchs enregistrés par une version sans clubs : Cholet Basket
const load = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).map(m => ({ club: 'basket', ...m })); } catch { return []; } };

// Réglages conservés : nombre de places par défaut (/places)
let settings = { places: 2 };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { /* valeurs par défaut */ }
const saveSettings = () => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); };

// ─── Affichage ───────────────────────────────────────────────────────────────────────────────────────────────────

const nbPlaces = n => `${n} place${n > 1 ? 's' : ''}`;
const several = CLUBS.length > 1;
// Emoji du club (seulement si plusieurs clubs sont suivis)
const badge = club => (several ? `${club.emoji} ` : '');
const clubOf = e => clubById(e.m.club);

// Nom court du match : adversaire (« JL Bourg », « DIJON »), sinon la date saisie, sinon d'après le lien
const shortName = e => {
  const label = (e.hunt && e.hunt.matchLabel) || e.m.label;
  if (label) return label.split(' · ')[0].split(/ (?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche) /i)[0];
  if (e.m.team) return e.m.team;
  if (e.m.date) return e.m.date.label;
  return clubOf(e).src.nameFromUrl(e.m.url);
};
const tag = e => `n°${e.m.n} ${badge(clubOf(e))}${shortName(e)} · `;
// « TRIBUNE REHLKO - NIVEAU 4 BANCS - rang N places 45, 46 - 36,00 € » → « REHLKO · NIVEAU 4 BANCS · rang N places 45, 46 · 36 € »
const seatsText = desc => desc.replace(/^TRIBUNE /, '').replace(/ - /g, ' · ').replace(/,00 €/, ' €');

// ─── Recherche d'un match : proposition, lancement, programmation, suppression ──────────────────────────────────

// Proposition de places : message avec boutons (panier ou paiement, Garder, Refuser, Arrêter), puis image en
// arrière-plan. Se résout avec 'keep', 'refuse', 'expired' (panier expiré sans réponse) ou 'cancel'.
async function propose(e, p) {
  // Match supprimé pendant la réservation : pas de proposition, le moteur s'arrête
  if (entries.get(e.m.n) !== e) return 'cancel';
  const id = Date.now().toString(36) + e.m.n;
  const head = `🎟 ${tag(e)}${nbPlaces(e.m.places)}\n${seatsText(p.desc)}\n${p.timing} · valable jusqu'à ${hhmm(p.expiresAt)}`;
  // Le lien ouvre le panier (Seetickets) ou la page de paiement de la commande (Billetweb) sur le téléphone
  const open = [{ text: p.linkText, url: p.link }];
  const msg = await tg.send(head, { buttons: [open, [{ text: '✅ Garder', data: `keep:${id}` }, { text: '❌ Refuser', data: `refuse:${id}` }, { text: '⏹ Arrêter', data: `stop:${id}` }]] });
  // L'image ne retarde pas la proposition
  p.image().then(async file => { await tg.sendPhoto(file, seatsText(p.desc)); fs.unlink(file, () => {}); })
    .catch(err => log('image :', err.message.split('\n')[0]));
  const decision = await new Promise(resolve => {
    const timer = setTimeout(() => done('expired'), Math.max(0, p.expiresAt - Date.now()));
    function done(d) { clearTimeout(timer); proposals.delete(id); resolve(d); }
    proposals.set(id, { done, n: e.m.n, released: p.released, expiresAt: p.expiresAt });
  });
  // Places refusées : libérées tout de suite (panier vidé) ou à l'expiration de la commande (Billetweb)
  const later = p.released === 'expiry' ? ` (libérées à ${hhmm(p.expiresAt)})` : '';
  const outcome = {
    keep: `✅ Gardées — paie avant ${hhmm(p.expiresAt)}.`,
    refuse: `❌ Refusées${later}, je cherche d'autres places.`,
    expired: '⌛ Expiré, je reprends.',
    cancel: p.released === 'expiry' ? `⏹ Recherche arrêtée${later}.` : '⏹ Recherche arrêtée, panier vidé.',
  }[decision];
  // Places gardées : le bouton du panier (ou du paiement) reste, pour payer
  if (msg) await tg.edit(msg.message_id, `${head}\n${outcome}`, { buttons: decision === 'keep' ? [open] : undefined });
  else await tg.send(outcome);
  log(`n°${e.m.n} proposition :`, decision);
  return decision;
}

// Lance (ou relance) la recherche d'un match programmé
async function run(e, resumed = false) {
  const m = e.m, club = clubOf(e), openAt = new Date(m.openAt);
  const hunt = e.hunt = new club.src.Hunt({
    club, url: m.url, date: m.date, team: m.team, openAt: openAt.getTime(), places: m.places,
    events: { info: t => tg.send(tag(e) + t), proposal: p => propose(e, p) },
  });
  if (!resumed) await tg.send(`👍 ${tag(e)}${nbPlaces(m.places)} · ${openAt <= Date.now() ? 'recherche immédiate' : `ouverture ${when(openAt)}`}`);
  log(`n°${m.n} [${club.id}] recherche :`, m.url || hunt.target, 'ouverture', openAt.toISOString(), m.places, 'places');
  let result;
  try { result = await hunt.run(); } catch (err) { result = 'error'; log(`n°${m.n} erreur :`, err.stack); }
  if (entries.get(m.n) !== e || e.hunt !== hunt) return;  // supprimé ou relancé entre-temps
  if (result === 'error') {
    // Erreur inattendue : nouvel essai, le match reste programmé
    await tg.send(`${tag(e)}⚠️ Erreur, nouvel essai dans 30 s.`);
    setTimeout(() => { if (entries.get(m.n) === e && e.hunt === hunt) run(e, true); }, 30000);
    return;
  }
  // Terminé : places gardées, arrêté, ou échec signalé par le moteur ('failed')
  entries.delete(m.n); save();
  if (result === 'cancelled') await tg.send(`${tag(e)}⏹ Arrêté.`);
}

// Ajoute un match programmé ; refuse un doublon (même club et même date, même adversaire ou même lien)
function schedule(m) {
  const club = clubById(m.club);
  const missing = club.src.missingSettings(club);
  if (missing.length) return tg.send(`${badge(club)}${club.name} : réglages manquants dans .env (${missing.join(', ')}). Les billets sont envoyés à ces coordonnées.`);
  const same = (a, b) => a.club === b.club && ((a.date && b.date && sameDate(a.date, b.date)) || (a.url && a.url === b.url) ||
    (a.team && b.team && norm(a.team) === norm(b.team) && (!a.date || !b.date)));
  const dup = [...entries.values()].find(e => same(e.m, m));
  if (dup) return tg.send(`Déjà programmé (n°${dup.m.n}).`);
  m.n = Math.max(0, ...entries.keys()) + 1;
  const e = { m, hunt: null };
  entries.set(m.n, e);
  save();
  run(e);
}

// Supprime un match programmé : arrête sa recherche (et une éventuelle proposition en attente)
// quiet : pas de message (bouton « Arrêter » : le message de la proposition l'indique déjà)
async function remove(n, { quiet = false } = {}) {
  const e = entries.get(n);
  if (!e) return tg.send(`Pas de n°${n}.`);
  entries.delete(n); save();
  if (e.hunt) e.hunt.cancel();
  // Places proposées en attente : le moteur vide le panier en s'arrêtant (ou la commande expire d'elle-même)
  let cart = '';
  for (const p of proposals.values()) {
    if (p.n !== n) continue;
    p.done('cancel');
    cart = p.released === 'expiry' ? `, places libérées à ${hhmm(p.expiresAt)}` : ', panier vidé';
  }
  if (!quiet) return tg.send(`🗑 n°${n} ${badge(clubOf(e))}${shortName(e)} supprimé${cart}.`);
}

// ─── Commandes ───────────────────────────────────────────────────────────────────────────────────────────────────

// Club éventuel en premier mot (« hockey », « basket ») : { club, rest }. Sans club : le premier des clubs suivis.
function takeClub(args) {
  const club = clubByAlias(args[0]);
  return club ? { club, rest: args.slice(1), explicit: true } : { club: CLUBS[0], rest: args, explicit: false };
}

// « /match [club] Bourg 01/12 15:00 [places] » ou « /match [club] 22 octobre 2026 01/12 15:00 » → club, adversaire ou
// date du match, ouverture, places (un lien de match est aussi accepté, son club est reconnu)
function parseMatchCommand(args) {
  let { club, rest: t } = takeClub(args);
  t = [...t];
  let places = null;  // absent : nombre de places par défaut (/places)
  if (/^places?$/i.test(t[t.length - 1] || '')) t.pop();
  if (/^\d$/.test(t[t.length - 1] || '') && t.length > 1) places = +t.pop();
  let opening;
  const last = (t[t.length - 1] || '').toLowerCase();
  if (last === 'maintenant' || last === 'now') opening = t.splice(-1).join(' ');
  else if (/^\d{1,2}[:h]\d{2}$/.test(last)) opening = t.splice(/^\d{1,2}\/\d{1,2}(\/\d{4})?$/.test(t[t.length - 2] || '') && t.length > 2 ? -2 : -1).join(' ');
  const openAt = opening ? parseOpening(opening) : null;
  if (/^https?:/.test(t[0] || '')) return { club: clubOfUrl(t[0]), url: t[0], openAt, places, badUrl: !clubOfUrl(t[0]) };
  const text = t.join(' ').trim();
  const date = parseMatchDate(text);
  if (date) return { club, date, openAt, places };
  // Pas une date : nom de l'adversaire, cherché sur la billetterie à l'ouverture
  return { club, team: /[a-zà-ÿ]{2}/i.test(text) ? text : null, openAt, places };
}

// Commandes affichées dans le menu Telegram (« / » et bouton Menu)
const COMMANDS = [
  { command: 'calendrier', description: 'Matchs à venir et ouvertures de billetterie' },
  { command: 'matchs', description: 'Matchs en vente' },
  { command: 'match', description: `Programmer : /match ${several ? '[club] ' : ''}Bourg 01/12 15:00 [places]` },
  { command: 'statut', description: 'Matchs programmés' },
  { command: 'supprimer', description: 'Supprimer : /supprimer n°' },
  { command: 'places', description: 'Places par défaut : /places 4 ; d\'un match : /places 3 n°' },
  { command: 'aide', description: 'Aide' },
];

const pct = x => `${Math.round(x * 100)} %`;
const HELP = [
  `/calendrier${several ? ' [club]' : ''} — matchs à venir et ouvertures (➕ pour programmer)`,
  `/matchs${several ? ' [club]' : ''} — matchs en vente (➕ pour programmer)`,
  `/match ${several ? '[club] ' : ''}Bourg 01/12 15:00 [places] — programmer une ouverture`,
  '/statut — matchs programmés (🗑 pour supprimer)',
  '/supprimer n° — supprimer un match',
  '/places 4 [n°] — places par défaut, ou d\'un match',
  '',
  ...(several ? [`Clubs : ${CLUBS.map(c => `${c.emoji} ${c.aliases[0]}`).join(', ')} (sans club : ${CLUBS[0].aliases[0]}).`] : []),
  ...CLUBS.map(c => `${c.emoji} ${c.name} : ${c.rules.tribunes.join(' > ')} · ${pct(c.rules.milieu)} central · ${pct(c.rules.hauteur)} de hauteur · ${c.rules.summary}.`),
].join('\n');

// Clubs visés par /matchs et /calendrier : celui donné en argument, sinon tous
function clubsFor(args) {
  if (!args[0]) return CLUBS;
  const c = clubByAlias(args[0]);
  return c ? [c] : null;
}

// Lecture des billetteries avec un navigateur temporaire
async function withPage(fn) {
  const browser = await chromium.launch();
  try { return await fn(await (await browser.newContext(CONTEXT_OPTIONS)).newPage()); } finally { await browser.close(); }
}

// Matchs en vente sur la billetterie de chaque club, à programmer en un clic (recherche immédiate)
async function listOnSale(args) {
  const clubs = clubsFor(args);
  if (!clubs) return tg.send(`Club inconnu. Clubs : ${CLUBS.map(c => c.aliases[0]).join(', ')}.`);
  const found = await withPage(async page => {
    const out = [];
    for (const club of clubs) {
      try { for (const x of await club.src.onSale(club, page)) out.push({ ...x, club: club.id }); }
      catch (e) { log(`${club.id} /matchs :`, e.message); await tg.send(`${badge(club)}${club.name} : billetterie illisible.`); }
    }
    return out;
  });
  onSaleList = found;
  if (!found.length) return tg.send('Aucun match en vente. /calendrier pour les prochaines ouvertures.');
  return tg.send(`En vente (➕ = ${nbPlaces(settings.places)}, recherche immédiate) :`,
    { buttons: found.map((x, i) => [{ text: `➕ ${badge(clubById(x.club))}${x.label}`, data: `prog:${i}` }]) });
}

// Matchs à venir de chaque club avec l'ouverture de leur billetterie
async function showCalendar(args) {
  const clubs = clubsFor(args);
  if (!clubs) return tg.send(`Club inconnu. Clubs : ${CLUBS.map(c => c.aliases[0]).join(', ')}.`);
  const sections = await withPage(async page => {
    const out = [];
    for (const club of clubs) {
      try { out.push({ club, ...(await club.src.calendar(club, page, DATA_DIR)) }); }
      catch (e) { log(`${club.id} /calendrier :`, e.message); out.push({ club, items: [], warning: '⚠️ Calendrier illisible.' }); }
    }
    return out;
  });
  calendarList = [];
  const scheduled = (club, x) => [...entries.values()].find(e => e.m.club === club.id && ((e.m.date && sameDate(e.m.date, x.date)) || (x.url && e.m.url === x.url)));
  const text = [], buttons = [];
  for (const { club, items, warning } of sections) {
    if (several) text.push(`${club.emoji} ${club.name}`);
    if (!items.length) text.push('Aucun match à venir.');
    for (const x of items) {
      const s = scheduled(club, x);
      const open = x.onSale ? '🟢 en vente' : x.opening ? `🎫 ${when(x.opening)}` : '❔ ouverture inconnue';
      text.push(`${when(x.at)} ${x.opponent}\n   ${open}${s ? ` · ✅ n°${s.m.n}` : ''}`);
      if ((x.onSale || x.opening) && !s) {
        calendarList.push({ ...x, club: club.id });
        buttons.push([{ text: `➕ ${badge(club)}${x.opponent}`, data: `cal:${calendarList.length - 1}` }]);
      }
    }
    if (warning) text.push(warning);
    text.push('');
  }
  text.push(`🎫 ouverture · ➕ = ${nbPlaces(settings.places)}` + (sections.some(s => s.items.some(x => !x.onSale && !x.opening)) ? '\n❔ : /match avec l\'heure d\'ouverture' : ''));
  return tg.send(text.join('\n'), { buttons });
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
  return `n°${e.m.n} ${badge(clubOf(e))}${shortName(e)} · ${nbPlaces(e.m.places)} · ${state}${refused}`;
}

// Liste des matchs programmés, avec un bouton de suppression par match
function status() {
  if (!entries.size) return tg.send('Aucun match programmé. /calendrier pour en ajouter.');
  const list = [...entries.values()];
  return tg.send(list.map(entryStatus).join('\n'), { buttons: list.map(e => [{ text: `🗑 n°${e.m.n} ${shortName(e)}`, data: `del:${e.m.n}` }]) });
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

function scheduleCommand(args) {
  const c = parseMatchCommand(args);
  const ex = `Exemple : /match ${several ? `${CLUBS[CLUBS.length - 1].aliases[0]} ` : ''}Bourg 01/12 15:00`;
  if (c.badUrl) return tg.send('Lien invalide.');
  if (!c.url && !c.date && !c.team) return tg.send(ex);
  if (!c.openAt) return tg.send(`Ouverture invalide. ${ex}`);
  const places = c.places || settings.places;
  if (places < 1 || places > MAX_PLACES) return tg.send(`Entre 1 et ${MAX_PLACES} places.`);
  return schedule({ club: c.club.id, url: c.url, date: c.date, team: c.team, openAt: c.openAt.toISOString(), places });
}

async function onCommand(text) {
  const [cmd, ...args] = text.trim().split(/\s+/);
  switch (cmd.replace(/@.*/, '').toLowerCase()) {
    case '/start': case '/aide': case '/help': return tg.send(HELP);
    case '/matchs': return listOnSale(args);
    case '/calendrier': return showCalendar(args);
    case '/match': return scheduleCommand(args);
    case '/places': return setPlaces(args);
    case '/statut': case '/status': return status();
    case '/supprimer': case '/annuler': case '/stop':
      // Sans n° : liste avec un bouton par match (pas de suppression sans choix explicite)
      return args[0] && /^\d+$/.test(args[0]) ? remove(+args[0]) : status();
    default: return tg.send('Commande inconnue. /aide');
  }
}

// ─── Boutons ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function onCallback(cb) {
  const [action, id] = String(cb.data || '').split(':');
  if (action === 'prog') {
    const x = onSaleList[+id];
    if (!x) return tg.answerCallback(cb.id, 'Liste expirée : /matchs');
    await tg.answerCallback(cb.id, 'OK');
    return schedule({ club: x.club, url: x.url, date: x.date, label: x.label, openAt: new Date().toISOString(), places: settings.places });
  }
  if (action === 'cal') {
    const x = calendarList[+id];
    if (!x) return tg.answerCallback(cb.id, 'Liste expirée : /calendrier');
    await tg.answerCallback(cb.id, 'OK');
    return schedule({ club: x.club, url: x.url, date: x.date, team: x.team, label: x.opponent,
      openAt: new Date(Math.max(+(x.opening || 0), Date.now())).toISOString(), places: settings.places });
  }
  if (action === 'del') {
    await tg.answerCallback(cb.id, 'OK');
    return remove(+id);
  }
  const p = proposals.get(id);
  if (!p) return tg.answerCallback(cb.id, 'Expiré');
  if (action === 'stop') { await tg.answerCallback(cb.id, 'Recherche arrêtée'); return remove(p.n, { quiet: true }); }
  await tg.answerCallback(cb.id, 'OK');
  p.done(action === 'keep' ? 'keep' : 'refuse');
}

// ─── Démarrage ───────────────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'])
    if (!process.env[k]) { console.error(`Variable ${k} manquante`); process.exit(1); }
  for (const c of CLUBS) {
    const missing = c.src.missingSettings(c);
    log(`Club ${c.name} (${c.src.name})${missing.length ? ` : réglages manquants ${missing.join(', ')}` : ''}`);
  }
  // Liste des commandes dans le menu Telegram
  const r0 = await tg.setCommands(COMMANDS);
  if (!r0.ok) log('setMyCommands :', r0.description);
  // Messages arrivés pendant l'arrêt du bot ignorés : pas de commande rejouée par surprise
  let offset = 0;
  const pending = await tg.getUpdates(-1, 0);
  if (pending.ok && pending.result.length) offset = pending.result[pending.result.length - 1].update_id + 1;
  const saved = load().filter(m => {
    if (clubById(m.club)) return true;
    log(`n°${m.n} ignoré : club ${m.club} inactif (CLUBS)`);
    return false;
  });
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
module.exports = { onCommand, onCallback, parseMatchCommand, COMMANDS, HELP };
