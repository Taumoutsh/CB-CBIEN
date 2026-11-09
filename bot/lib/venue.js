// Plan de toute la salle, envoyé après celui de la tribune : toutes les tribunes (ou zones), le terrain, la place
// proposée. Chaque billetterie décrit sa salle dans son propre repère (unités du plan du site) ; ce module la dessine.
//
// Description : { title, court: { x, y, w, h, label, round }, blocks: [{ points: [{x,y}] | rect: {x,y,w,h}, label,
//   highlight }], seats: [{ x, y, free }], mine: [{ x, y }], seatSize }
const os = require('os'), path = require('path');

const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');

async function venueImage(browser, d) {
  // Emprise de tout ce qui est dessiné
  const pts = [];
  for (const b of d.blocks || []) {
    if (b.points) pts.push(...b.points);
    if (b.rect) pts.push({ x: b.rect.x, y: b.rect.y }, { x: b.rect.x + b.rect.w, y: b.rect.y + b.rect.h });
  }
  for (const s of d.seats || []) pts.push(s);
  for (const b of d.blocks || []) if (b.labelAt) pts.push(b.labelAt);  // libellés placés hors des blocs : dans l'image
  if (d.court) pts.push({ x: d.court.x, y: d.court.y }, { x: d.court.x + d.court.w, y: d.court.y + d.court.h });
  const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x));
  const minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y));
  const M = 40, T = 62, maxW = 1400, maxH = 1100;
  const k = Math.min((maxW - 2 * M) / ((maxX - minX) || 1), (maxH - T - M) / ((maxY - minY) || 1));
  const W = (maxX - minX) * k + 2 * M, H = (maxY - minY) * k + T + M;
  const X = x => M + (x - minX) * k, Y = y => T + (y - minY) * k;
  const r = Math.max(1.2, Math.min(5, (d.seatSize || 1) * k * 0.42));
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Arial, sans-serif">`,
    `<rect width="100%" height="100%" fill="#fff"/>`,
    `<text x="${W / 2}" y="20" text-anchor="middle" font-size="15" font-weight="bold">${esc(d.title)}</text>`,
    `<text x="${W / 2}" y="37" text-anchor="middle" font-size="11" fill="#555"><tspan fill="#e3001b">●</tspan> place proposée${d.seats && d.seats.length ? '   <tspan fill="#8fd18f">●</tspan> libre   <tspan fill="#bbb">●</tspan> indisponible' : ''}</text>`];
  if (d.court) {
    const c = d.court, rr = c.round ? Math.min(c.w, c.h) * k * 0.25 : 4;
    out.push(`<rect x="${X(c.x)}" y="${Y(c.y)}" width="${c.w * k}" height="${c.h * k}" rx="${rr}" fill="${c.fill || '#e8f1fb'}" stroke="#7aa3c9" stroke-width="2"/>`,
      `<text x="${X(c.x + c.w / 2)}" y="${Y(c.y + c.h / 2) + 6}" text-anchor="middle" font-size="18" font-weight="bold" fill="#7aa3c9">${esc(c.label || 'TERRAIN')}</text>`);
  }
  for (const b of d.blocks || []) {
    const fill = b.highlight ? '#ffd9a8' : b.fill || '#f3f3f3', stroke = b.highlight ? '#d26a00' : '#bbb', sw = b.highlight ? 2.5 : 1;
    if (b.points) out.push(`<polygon points="${b.points.map(p => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
    if (b.rect) out.push(`<rect x="${X(b.rect.x)}" y="${Y(b.rect.y)}" width="${b.rect.w * k}" height="${b.rect.h * k}" fill="${b.seatsInside ? 'none' : fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
  }
  for (const s of d.seats || []) out.push(`<circle cx="${X(s.x).toFixed(1)}" cy="${Y(s.y).toFixed(1)}" r="${r.toFixed(1)}" fill="${s.free ? '#8fd18f' : '#dcdcdc'}"/>`);
  for (const b of d.blocks || []) {
    if (!b.label) continue;
    const p = b.labelAt || (b.points ? { x: b.points.reduce((t, q) => t + q.x, 0) / b.points.length, y: b.points.reduce((t, q) => t + q.y, 0) / b.points.length } : { x: b.rect.x + b.rect.w / 2, y: b.rect.y + b.rect.h / 2 });
    out.push(`<text x="${X(p.x)}" y="${Y(p.y) + 4}" text-anchor="middle" font-size="11" font-weight="${b.highlight ? 'bold' : 'normal'}" fill="${b.highlight ? '#a04f00' : '#555'}" stroke="#fff" stroke-width="3" paint-order="stroke">${esc(b.label)}</text>`);
  }
  // Place proposée : point rouge, entouré pour rester visible à petite échelle
  for (const m of d.mine || []) out.push(`<circle cx="${X(m.x)}" cy="${Y(m.y)}" r="${Math.max(r * 1.8, 5)}" fill="#e3001b" stroke="#000" stroke-width="1.5"/>`);
  if ((d.mine || []).length) {
    const cx = d.mine.reduce((t, m) => t + X(m.x), 0) / d.mine.length, cy = d.mine.reduce((t, m) => t + Y(m.y), 0) / d.mine.length;
    out.push(`<circle cx="${cx}" cy="${cy}" r="${Math.max(r * 6, 16)}" fill="none" stroke="#e3001b" stroke-width="2.5"/>`);
  }
  out.push('</svg>');
  const page = await browser.newPage();
  try {
    await page.setContent(`<body style="margin:0">${out.join('\n')}</body>`);
    const file = path.join(os.tmpdir(), `salle-${Date.now()}.png`);
    await page.locator('svg').screenshot({ path: file });
    return file;
  } finally { await page.close(); }
}

module.exports = { venueImage };
