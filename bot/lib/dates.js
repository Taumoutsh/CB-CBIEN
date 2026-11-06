// Dates, heures de Paris et noms d'équipes : outils communs à toutes les billetteries.

const MONTHS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Texte sans accents ni majuscules, espaces simplifiés
const norm = t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
// Numéro du mois d'après son nom, même abrégé ou mal lu (« nov. », « octabre ») ; 0 si inconnu
const monthOf = w => { const n = norm(w).replace(/\./g, '').slice(0, 3); return MONTHS.findIndex(x => x.startsWith(n)) + 1 || MONTHS_EN.indexOf(n) + 1; };

// Heure de Paris → Date, sans dépendance (gère l'heure d'été)
function parisOffsetMs(ts) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ts));
  const g = t => +parts.find(p => p.type === t).value;
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ts / 1000) * 1000;
}
function parisTime(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - parisOffsetMs(guess);
  t = guess - parisOffsetMs(t);
  return new Date(t);
}

// Date d'un match : « 22 octobre 2026 », « 1er décembre », « 22/10/2026 » ou « 22/10 » (sans année : prochaine
// occurrence) → { d, m, y, label }, ou null
function parseMatchDate(text, now = new Date()) {
  const s = norm(text);
  let d, m, y;
  let r = s.match(/^(\d{1,2})(?:er)?\s+([a-z]{3,})\.?(?:\s+(\d{4}))?$/);
  if (r) { d = +r[1]; m = MONTHS.findIndex(x => x.startsWith(r[2].slice(0, 4))) + 1; y = r[3] && +r[3]; }
  else if ((r = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/))) { d = +r[1]; m = +r[2]; y = r[3] && +r[3]; }
  if (!d || !m || m > 12 || d > 31) return null;
  if (!y) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(now).split('-').map(Number);
    y = parts[0];
    if (m < parts[1] || (m === parts[1] && d < parts[2])) y++;
  }
  return dateOf(d, m, y);
}
const dateOf = (d, m, y) => ({ d, m, y, label: `${d} ${MONTHS_FR[m - 1]} ${y}` });
const sameDate = (a, b) => !!a && !!b && a.d === b.d && a.m === b.m && a.y === b.y;

// Ouverture de la billetterie : « maintenant », « HH:MM », « JJ/MM HH:MM » ou « JJ/MM/AAAA HH:MM » (heure de Paris) ;
// sans année : prochaine occurrence
function parseOpening(text, now = new Date()) {
  const s = text.trim().toLowerCase();
  if (s === 'maintenant' || s === 'now') return now;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(\d{1,2})[:h](\d{2})$/);
  const yearNow = +new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', year: 'numeric' }).format(now);
  if (m) {
    let d = parisTime(m[3] ? +m[3] : yearNow, +m[2], +m[1], +m[4], +m[5]);
    if (!m[3] && d < now - 86400000) d = parisTime(yearNow + 1, +m[2], +m[1], +m[4], +m[5]);
    return d;
  }
  m = s.match(/^(\d{1,2})[:h](\d{2})$/);
  if (m) {
    const today = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).split('/');
    let d = parisTime(+today[2], +today[1], +today[0], +m[1], +m[2]);
    if (d < now - 3600000) d = new Date(d.getTime() + 86400000);
    return d;
  }
  return null;
}

// Mots d'un nom d'équipe, abréviations courantes développées (« St Quentin » ↔ « SAINT-QUENTIN »)
const ABBR = { st: 'saint', ste: 'sainte' };
const words = t => norm(t).split(/[^a-z0-9]+/).filter(w => w.length >= 2).map(w => ABBR[w] || w);
// L'adversaire écrit sur la billetterie correspond-il au nom saisi ? Tous les mots saisis doivent y être, sans accents
// ni majuscules ni tirets (« Saint Quentin » ↔ « SAINT-QUENTIN », « Chalon » ↔ « CHALON SUR SAONE »)
function teamMatches(wanted, opponent) {
  const w = words(wanted), have = new Set(words(opponent));
  return w.length > 0 && w.every(x => have.has(x));
}

// Formats d'affichage (heure de Paris)
const fmt = o => t => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', ...o }).format(t).replace(' ', ' ');
const hhmm = fmt({ hour: '2-digit', minute: '2-digit' });
const when = fmt({ weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });  // « sam. 12/12 18:00 »

module.exports = { MONTHS, MONTHS_FR, norm, monthOf, parisTime, parseMatchDate, dateOf, sameDate, parseOpening, words, teamMatches, hhmm, when };
