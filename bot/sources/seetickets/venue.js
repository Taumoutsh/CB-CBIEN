// Salle entière du basket pour lib/venue.js : Seetickets ne donne que le plan de chaque tribune ; elles sont placées
// autour du terrain selon la disposition de la salle (clubs.js, rules.layout) : Ouest France et Cholet Agglomération
// face à face sur les grands côtés, Rehlko et EGDC aux extrémités, rangs A tournés vers le terrain.
const { geometry } = require('../../lib/seats');

// datas : { clé de tribune: { seats } } (lecture du tour), names : { clé: nom affiché }, best : { key, seats }
function venueOf(datas, names, layout, best, title) {
  const T = {};
  for (const [k, side] of Object.entries(layout)) {
    const d = datas[k];
    if (!d || !d.seats.length) continue;
    const g = geometry(d.seats);
    // Repère local : u le long de la tribune (0 → largeur), v depuis le terrain (0 = rang le plus proche)
    T[k] = { side, g, W: g.maxX - g.minX + 1, D: g.maxY - g.minY + 1, local: s => ({ u: s.x - g.minX, v: g.courtBottom ? g.maxY - s.y : s.y - g.minY }) };
  }
  const sides = side => Object.values(T).filter(t => t.side === side);
  const L = Math.max(30, ...sides('haut').concat(sides('bas')).map(t => t.W * 0.9));   // longueur du terrain
  const H = Math.max(18, ...sides('gauche').concat(sides('droite')).map(t => t.W * 0.9)); // largeur du terrain
  const gap = 2;
  // Position dans la salle (terrain centré sur 0,0), tribune tournée vers le terrain
  const place = (t, s) => {
    const { u, v } = t.local(s);
    switch (t.side) {
      case 'haut': return { x: -t.W / 2 + u, y: -H / 2 - gap - v };
      case 'bas': return { x: t.W / 2 - u, y: H / 2 + gap + v };
      case 'gauche': return { x: -L / 2 - gap - v, y: t.W / 2 - u };
      default: return { x: L / 2 + gap + v, y: -t.W / 2 + u };
    }
  };
  const seats = [], blocks = [];
  for (const [k, t] of Object.entries(T)) {
    const pts = datas[k].seats.map(s => ({ ...place(t, s), free: s.free, id: s.id }));
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const rect = { x: Math.min(...xs) - 1, y: Math.min(...ys) - 1, w: Math.max(...xs) - Math.min(...xs) + 2, h: Math.max(...ys) - Math.min(...ys) + 2 };
    const label = String(names[k] || k).replace(/^TRIBUNE /i, '');
    const labelAt = { haut: { x: rect.x + rect.w / 2, y: rect.y - 1.5 }, bas: { x: rect.x + rect.w / 2, y: rect.y + rect.h + 2.5 }, gauche: { x: rect.x + rect.w / 2, y: rect.y - 1.5 }, droite: { x: rect.x + rect.w / 2, y: rect.y - 1.5 } }[t.side];
    blocks.push({ rect, label, seatsInside: true, highlight: k === best.key, labelAt });
    const ids = new Set(best.seats.map(s => String(s.id)));
    seats.push(...pts.filter(p => !(k === best.key && ids.has(String(p.id)))));
  }
  const t = T[best.key];
  const mine = t ? best.seats.map(s => place(t, s)) : [];
  return { title, court: { x: -L / 2, y: -H / 2, w: L, h: H, label: 'TERRAIN' }, blocks, seats, mine, seatSize: 1 };
}

module.exports = { venueOf };
