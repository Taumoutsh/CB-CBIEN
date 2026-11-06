// Règles de placement communes : zone acceptée d'une tribune (largeur centrale, hauteur depuis le terrain)
// et image du plan envoyée avec chaque proposition.
// Siège : { id, x, y, rang, free } (x vers la droite, y vers le bas, dans l'unité du plan du site).
const os = require('os'), path = require('path');

// Écart habituel entre deux sièges voisins d'un même rang (1 sur une grille, ≈ 28 sur un plan en coordonnées)
function seatSpacing(seats) {
  const rows = {};
  for (const s of seats) (rows[Math.round(s.y)] = rows[Math.round(s.y)] || []).push(s.x);
  const d = [];
  for (const xs of Object.values(rows)) { xs.sort((a, b) => a - b); for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 1e-6) d.push(xs[i] - xs[i - 1]); }
  d.sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] : 1;
}

// Géométrie de la tribune : centre et demi-largeur, position verticale des rangs (0 = côté terrain, 1 = tout en haut)
function geometry(seats) {
  const xs = seats.map(s => s.x), ys = seats.map(s => s.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const a = seats.find(s => s.rang === 'A');
  const courtBottom = !a || a.y > (minY + maxY) / 2;  // le rang A est le plus proche du terrain
  const span = (maxY - minY) || 1;
  return {
    minX, maxX, minY, maxY, courtBottom, unit: seatSpacing(seats),
    cx: (minX + maxX) / 2, half: ((maxX - minX) / 2) || 1,
    height: y => (courtBottom ? maxY - y : y - minY) / span,
  };
}

// Siège dans la zone acceptée : `milieu` de la largeur au centre, rangs depuis le terrain jusqu'à `hauteur`
const inZone = (geo, rules) => s => Math.abs(s.x - geo.cx) / geo.half <= rules.milieu + 1e-9 && geo.height(s.y) <= rules.hauteur + 1e-9;

// Plan dessiné d'après les sièges : places proposées en rouge, libres en vert, zone acceptée en pointillés,
// terrain du côté du rang A. Renvoie le chemin d'un PNG.
async function seatMapImage(browser, seats, mine, title, rules) {
  const geo = geometry(seats);
  const ids = new Set(mine.map(s => s.id));
  const C = 14, L = 34, T = 46, B = 44, k = C / geo.unit;
  const W = (geo.maxX - geo.minX) * k + C + 2 * L, H = T + (geo.maxY - geo.minY) * k + C + B;
  const X = x => L + (x - geo.minX) * k + C / 2, Y = y => T + (y - geo.minY) * k + C / 2;
  const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const rows = {};
  for (const s of seats) if (!rows[s.rang]) rows[s.rang] = s;  // une étiquette par rang
  // Zone acceptée : largeur centrale, et rangs depuis le terrain jusqu'à la hauteur maximale
  const zx0 = X(geo.cx - rules.milieu * geo.half) - C / 2, zx1 = X(geo.cx + rules.milieu * geo.half) + C / 2;
  const span = geo.maxY - geo.minY;
  const yLimit = geo.courtBottom ? geo.maxY - rules.hauteur * span : geo.minY + rules.hauteur * span;
  const zy0 = geo.courtBottom ? Y(yLimit) - C / 2 : Y(geo.minY) - C / 2;
  const zy1 = geo.courtBottom ? Y(geo.maxY) + C / 2 : Y(yLimit) + C / 2;
  const courtY = geo.courtBottom ? Y(geo.maxY) + C : T - 24;
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Arial, sans-serif">`,
    `<rect width="100%" height="100%" fill="#fff"/>`,
    `<text x="${W / 2}" y="20" text-anchor="middle" font-size="15" font-weight="bold">${esc(title)}</text>`,
    `<text x="${W / 2}" y="37" text-anchor="middle" font-size="11" fill="#555"><tspan fill="#e3001b">●</tspan> réservé   <tspan fill="#8fd18f">●</tspan> libre   <tspan fill="#bbb">●</tspan> indisponible   ┅ zone acceptée</text>`,
    `<rect x="${zx0}" y="${zy0}" width="${zx1 - zx0}" height="${zy1 - zy0}" fill="#fff8e0" stroke="#c90" stroke-dasharray="5 4"/>`,
    ...Object.values(rows).map(s => `<text x="${L - 6}" y="${Y(s.y) + 4}" text-anchor="end" font-size="10" fill="#666">${esc(s.rang)}</text><text x="${W - L + 6}" y="${Y(s.y) + 4}" font-size="10" fill="#666">${esc(s.rang)}</text>`),
    ...seats.filter(s => !ids.has(s.id)).map(s => `<circle cx="${X(s.x)}" cy="${Y(s.y)}" r="4.5" fill="${s.free ? '#8fd18f' : '#dcdcdc'}"/>`),
    ...seats.filter(s => ids.has(s.id)).map(s => `<circle cx="${X(s.x)}" cy="${Y(s.y)}" r="6.5" fill="#e3001b" stroke="#000" stroke-width="1.5"/>`),
    `<rect x="${L}" y="${courtY}" width="${W - 2 * L}" height="20" fill="#c8102e"/>`,
    `<text x="${W / 2}" y="${courtY + 14}" text-anchor="middle" font-size="12" fill="#fff" font-weight="bold">TERRAIN</text>`,
    `</svg>`].join('\n');
  const page = await browser.newPage();
  try {
    await page.setContent(`<body style="margin:0">${svg}</body>`);
    const file = path.join(os.tmpdir(), `places-${Date.now()}.png`);
    await page.locator('svg').screenshot({ path: file });
    return file;
  } finally { await page.close(); }
}

module.exports = { geometry, inZone, seatMapImage };
