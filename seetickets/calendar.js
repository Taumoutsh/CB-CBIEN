// Calendrier des matchs à domicile (site du club) et ouvertures de billetterie (bannière de la page de la billetterie,
// lue par OCR avec Tesseract). La bannière n'est relue que lorsque son image change (résultat gardé dans DATA_DIR).
const fs = require('fs'), os = require('os'), path = require('path');
const { execFile } = require('child_process');
const { CONFIG, MONTHS, norm, parisTime, parseMatchDate } = require('./hunt');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
// Pages du calendrier du club : championnat et Ligue des champions
const CALENDARS = env('CALENDRIERS', 'https://www.cholet-basket.com/calendrier,https://www.cholet-basket.com/calendrier/basketball-champions-league').split(',').map(s => s.trim()).filter(Boolean);
const DAYS = '(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)';
const monthOf = w => { const n = norm(w).slice(0, 3); return MONTHS.findIndex(x => x.startsWith(n)) + 1; };  // tolère « octabre »

// Matchs à domicile à venir : [{ opponent, competition, date: {d,m,y,label}, time: 'HH:MM', at }], triés par date
async function homeMatches(page) {
  const out = [];
  for (const url of CALENDARS) {
    const html = await (await page.request.get(url, { timeout: 20000 })).text();
    const rows = await page.evaluate(html => {
      const doc = new DOMParser().parseFromString(html, 'text/html'), r = [];
      const t = (e, s) => ((e.querySelector(s) || {}).textContent || '').replace(/\s+/g, ' ').trim();
      doc.querySelectorAll('.ligneMatch.domicile').forEach(e => r.push({ opponent: t(e, '.pasCholet'), date: t(e, '.dateMatch'), time: t(e, '.heureMatch'), competition: t(e, '.competition') }));
      return r;
    }, html);
    for (const x of rows) {
      const date = parseMatchDate(x.date);
      const hm = x.time.match(/(\d{1,2})\s*h\s*(\d{2})?/i);
      if (!date || !x.opponent) continue;
      const at = parisTime(date.y, date.m, date.d, hm ? +hm[1] : 20, hm && hm[2] ? +hm[2] : 0);
      out.push({ opponent: x.opponent, competition: x.competition, date, time: hm ? `${hm[1].padStart(2, '0')}:${hm[2] || '00'}` : '', at });
    }
  }
  const seen = new Set();
  return out.filter(m => m.at > Date.now() - 3 * 3600000 && !seen.has(+m.at) && seen.add(+m.at)).sort((a, b) => a.at - b.at);
}

const tesseract = file => new Promise((resolve, reject) => {
  execFile('tesseract', [file, '-', '-l', 'fra', '--psm', '3'], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    if (err) return reject(new Error(err.code === 'ENOENT' ? 'Tesseract non installé' : `OCR : ${String(err.message).split('\n')[0]}`));
    resolve(stdout);
  });
});

// Ouvertures lues dans le texte OCR : « - Bourg : Mardi 1er décembre à 15h » → { name, d, m, h, min }
function parseOpenings(text) {
  const rx = new RegExp(`([A-Za-zÀ-ÿ0-9][^:\\n]{1,45}?)\\s*:\\s*${DAYS}\\s+(\\d{1,2})(?:er)?\\s+([A-Za-zÀ-ÿ]+)\\.?\\s+[àa]\\s+(\\d{1,2})\\s*h\\s*(\\d{2})?`, 'gi');
  const out = [];
  for (const m of text.matchAll(rx)) {
    // Débris de la colonne voisine ou du bruit avant le tiret : « Sc - Limoges » → « Limoges »
    const name = m[1].split(/\s[-–]\s/).pop().replace(/^[-–\s.]+/, '').replace(/\s+/g, ' ').trim();
    const mo = monthOf(m[4]);
    if (name.length >= 2 && mo) out.push({ name, d: +m[3], m: mo, h: +m[5], min: m[6] ? +m[6] : 0 });
  }
  return out;
}

// Ouvertures de billetterie de la bannière : { src, openings: [{ name, at }] } ; OCR seulement si l'image a changé
async function bannerOpenings(page, dataDir) {
  const cacheFile = path.join(dataDir, 'banniere.json');
  const html = await (await page.request.get(CONFIG.listUrl, { timeout: 20000 })).text();
  const src = (html.match(/<img[^>]+src="([^"]+)"[^>]*id="miseEnAvant_/) || html.match(/<img[^>]+id="miseEnAvant_[^>]+src="([^"]+)"/) || [])[1];
  if (!src) throw new Error('bannière introuvable sur la billetterie');
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* première lecture */ }
  if (!cache || cache.src !== src) {
    const b64 = (await (await page.request.get(src, { timeout: 20000 })).body()).toString('base64');
    let best = null;
    // Image préparée dans le navigateur (agrandie ×3, texte clair → noir sur blanc), plusieurs seuils : le meilleur gagne
    for (const seuil of [180, 140, 100]) {
      const png = await page.evaluate(async ([b64, seuil]) => {
        const img = new Image(); img.src = 'data:image/jpeg;base64,' + b64; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width * 3; c.height = img.height * 3;
        const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, c.width, c.height);
        const d = g.getImageData(0, 0, c.width, c.height), a = d.data;
        for (let i = 0; i < a.length; i += 4) { const y = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2]; a[i] = a[i + 1] = a[i + 2] = y > seuil ? 0 : 255; }
        g.putImageData(d, 0, 0); return c.toDataURL('image/png').split(',')[1];
      }, [b64, seuil]);
      const file = path.join(os.tmpdir(), `banniere-${Date.now()}.png`);
      fs.writeFileSync(file, Buffer.from(png, 'base64'));
      let text;
      try { text = await tesseract(file); } finally { fs.unlink(file, () => {}); }
      const entries = parseOpenings(text);
      if (!best || entries.length > best.entries.length) best = { entries, text };
      if (entries.length >= 10) break;
    }
    // Année : saison en cours (juillet à juin), ou celle du titre (« saison 2026/27 ») si elle est plausible :
    // l'écriture stylisée du titre peut être mal lue (« 2006/27 »). De juillet à décembre = première année.
    const now = new Date();
    const current = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
    const season = best.text.match(/(20\d\d)\s*[\/-]\s*\d{2,4}/);
    const start = season && Math.abs(+season[1] - current) <= 1 ? +season[1] : current;
    cache = { src, readAt: now.toISOString(), openings: best.entries.map(o => ({ ...o, at: parisTime(o.m >= 7 ? start : start + 1, o.m, o.d, o.h, o.min).toISOString() })) };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
  }
  return { src, readAt: cache.readAt, openings: cache.openings.map(o => ({ ...o, at: new Date(o.at) })) };
}

// Mots significatifs d'un nom d'équipe (« JL Bourg » ↔ « Bourg », « Hapeol Holon (ISR) » ↔ « Hapoel Holon (BCL) »)
const STOP = new Set(['basket', 'basketball', 'club', 'elan', 'bcl', 'isr', 'les', 'the']);
const teamWords = t => new Set(norm(t).split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w)));

// Associe à chaque match à domicile l'ouverture de billetterie du même adversaire qui le précède (au plus 4 mois avant)
function associate(matches, openings) {
  return matches.map(m => {
    const mw = teamWords(m.opponent);
    const bcl = /champions/i.test(m.competition);
    const cands = openings.filter(o => {
      if (o.at >= m.at || m.at - o.at > 120 * 86400000) return false;
      if (/\(bcl\)/i.test(o.name) !== bcl) return false;  // la bannière marque les matchs de Ligue des champions
      const ow = teamWords(o.name);
      return [...ow].some(w => mw.has(w));
    }).sort((a, b) => b.at - a.at);
    const o = cands[0];
    return { ...m, opening: o ? o.at : null, bannerName: o ? o.name.replace(/\s*\((bcl|BCL)\)\s*/, ' ').trim() : null };
  });
}

module.exports = { homeMatches, bannerOpenings, associate, parseOpenings };
