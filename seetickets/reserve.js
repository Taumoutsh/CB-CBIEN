// Réservation de 2 places côte à côte (Ouest France ou Cholet Agglomération), sans paiement.
// Usage : node reserve.js [--dry-run] [--mobile] [--max-minutes=N] [--places=2]
// Identifiants : SEETICKETS_EMAIL / SEETICKETS_PASSWORD ; Telegram : TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.
// Rien de sensible n'est écrit dans un fichier ou un log.
const { execFileSync } = require('child_process');
const { chromium, openSection, login, URL_EVT, MOBILE, CONTEXT_OPTIONS } = require('./common');
const { handoverCode } = require('./handover');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const MAX_MIN = +(args.find(a => a.startsWith('--max-minutes=')) || '=30').split('=')[1];
const NB = +(args.find(a => a.startsWith('--places=')) || '=2').split('=')[1];

// Groupes de tarifs (pricesGroupId) : priorité 1 = niveaux 3/4 bancs, priorité 2 = niveau 2
const GROUPS = {
  2693567: { name: 'NIVEAU 3 BANCS', tier: 1 },
  2693571: { name: 'NIVEAU 4 BANCS', tier: 1 },
  2693557: { name: 'NIVEAU 2 BANCS', tier: 2 },
  2693565: { name: 'NIVEAU 2 FAUTEUILS', tier: 2 },
};
const TRIBUNE_NAMES = { ouest: 'TRIBUNE OUEST FRANCE', agglo: 'TRIBUNE CHOLET AGGLOMERATION' };

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { log('Telegram non configuré (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) :', text); return false; }
  // Le jeton passe par stdin (config curl), jamais en argument ni dans les logs
  const cfg = `url = "https://api.telegram.org/bot${token}/sendMessage"\n` +
    `data-urlencode = "chat_id=${chat}"\ndata-urlencode = "text=${text.replace(/\\/g, '\\\\').replace(/"/g, "'").replace(/\n/g, '\\n')}"\nsilent\nshow-error\n`;
  try {
    const out = execFileSync('curl', ['-K', '-', '-o', '-', '-w', '\n%{http_code}'], { input: cfg }).toString();
    const ok = out.trim().endsWith('200');
    log('Telegram', ok ? 'envoyé' : 'échec HTTP ' + out.trim().split('\n').pop());
    return ok;
  } catch (e) { log('Telegram erreur'); return false; }
}

// Rang le plus proche du terrain = meilleur (A < B < … < Z < ZA < ZB < ZC)
const rowRank = r => (r.length > 1 && r[0] === 'Z' ? 26 + r.charCodeAt(1) - 64 : r.charCodeAt(0) - 64);

// Liste des groupes de NB sièges contigus disponibles dans la tribune ouverte, triés du meilleur au moins bon
async function findCandidates(p) {
  const seats = JSON.parse(await p.evaluate(`(()=>{
    const rs = Map.instances['mapRoom_default-2'].plugins['MapRoomSection'];
    const out = [];
    for (const c in rs.seatsRegister) {
      const d = rs.getSeatData(rs.seatsRegister[c]);
      if (d && d.selectable) out.push({ id: d.id, x: d.x, y: d.y, cellId: d.cellId, rang: d.rang, num: d.numero, g: (rs.getSeatProps(d.id) || {}).pricesGroupId });
    }
    return JSON.stringify(out);
  })()`));
  const byPos = {}; let maxX = 0;
  for (const s of seats) { byPos[s.y + ':' + s.x] = s; maxX = Math.max(maxX, s.x); }
  const cands = [];
  for (const s of seats) {
    if (!GROUPS[s.g]) continue;
    const grp = [s];
    for (let k = 1; k < NB; k++) {
      const n = byPos[s.y + ':' + (s.x + k)];
      if (!n || n.g !== s.g || n.rang !== s.rang) break;
      grp.push(n);
    }
    if (grp.length !== NB) continue;
    const mid = s.x + (NB - 1) / 2;
    cands.push({ seats: grp, tier: GROUPS[s.g].tier, cat: GROUPS[s.g].name, rank: rowRank(s.rang), off: Math.abs(mid - maxX / 2) });
  }
  // Priorité : niveau, puis proximité du terrain, puis centrage
  cands.sort((a, b) => a.tier - b.tier || a.rank - b.rank || a.off - b.off);
  return { cands, nbFree: seats.length };
}

async function cartInfo(p) {
  const t = await p.evaluate(`(()=>{const e=document.querySelector('#compPanier1'); return e? e.textContent.replace(/\\s+/g,' ').trim() : ''})()`);
  // « Panier (2) » sur la version ordinateur, « Nombre d'articles : 2 » sur la version mobile
  const n = (t.match(/Panier \((\d+)\)|Nombre d'articles : (\d+)/) || []).slice(1).find(Boolean) || 0;
  const timer = (t.match(/Il vous reste ([^.]*) pour valider/) || [0, ''])[1];
  return { n: +n, text: t, timer };
}

async function emptyCart(p) {
  await p.goto(URL_EVT, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(2500);
  if ((await cartInfo(p)).n === 0) return;
  log('Vidage du panier partiel…');
  // Même action que le lien « Vider le panier », masqué dans le détail replié (versions ordinateur et mobile)
  await p.evaluate(`compPanier1.viderPanier()`).catch(e => log('Vider KO', e.message.split('\n')[0]));
  await p.waitForTimeout(800);
  // Éventuelle confirmation (jquery.alerts / impromptu)
  for (const sel of ['#popup_ok', '#jqibox button:has-text("OK")', '#jqibox button:has-text("Oui")', '#jqibox input[value="OK"]'])
    await p.locator(sel).first().click({ timeout: 1000 }).catch(() => {});
  await p.waitForTimeout(2500);
  await p.goto(URL_EVT, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2000);
  log('Panier après vidage :', (await cartInfo(p)).n, 'place(s)');
}

// Tente d'ajouter le groupe de sièges ; renvoie la réponse « add » du serveur (ou null)
async function tryAdd(p, cand) {
  await p.evaluate(`(()=>{const rs=Map.instances['mapRoom_default-2'].plugins['MapRoomSection']; rs.select(${JSON.stringify(cand.seats.map(s => s.cellId))}, true);})()`);
  await p.waitForTimeout(300);
  const btn = await p.locator('#validateButton').innerText();
  if (!btn.includes(`(${NB})`)) { log('Sélection incorrecte :', btn); return null; }
  await p.locator('#validateButton').click();
  await p.locator('#PricesSelector input.addToCart').waitFor({ timeout: 10000 });
  // Plein tarif pour chaque siège
  let tarifs = [];
  for (let i = 0; i < 20 && tarifs.length < NB; i++) {
    await p.waitForTimeout(150);
    tarifs = JSON.parse(await p.evaluate(`(()=>{const r=[]; document.querySelectorAll('#jqibox select').forEach(s=>{const o=Array.from(s.options).find(o=>/PLEIN TARIF/.test(o.text)); if(o) s.value=o.value; r.push(s.options[s.selectedIndex].text);}); return JSON.stringify(r);})()`));
  }
  log('Tarifs :', tarifs.join(' | '));
  if (tarifs.length !== NB || !tarifs.every(t => /PLEIN TARIF/.test(t))) {
    log('Fenêtre des tarifs inattendue, annulation');
    await p.locator('#PricesSelector input.cancel').click().catch(() => {});
    return null;
  }
  if (DRY) {
    log('[dry-run] arrêt avant « Valider » de la fenêtre des tarifs');
    await p.locator('#PricesSelector input.cancel').click().catch(() => {});
    return { dry: true };
  }
  const respP = p.waitForResponse(r => (r.request().postData() || '').includes('action=add'), { timeout: 20000 }).catch(() => null);
  await p.locator('#PricesSelector input.addToCart').click();
  const resp = await respP;
  let body = null;
  if (resp) { try { body = JSON.parse(await resp.text()); } catch { body = null; } }
  await p.waitForTimeout(2500);
  const alertTxt = await p.evaluate(`(()=>{const e=document.querySelector('#popup_container, #jqibox'); return e && e.offsetParent!==null ? e.innerText.replace(/\\s+/g,' ').slice(0,300) : ''})()`);
  if (alertTxt) log('Message du site :', alertTxt);
  return body;
}

(async () => {
  if (!process.env.SEETICKETS_EMAIL || !process.env.SEETICKETS_PASSWORD) { log('Identifiants Seetickets absents'); process.exit(1); }
  log(`Démarrage${DRY ? ' (dry-run)' : ''}${MOBILE ? ' (version mobile)' : ''} : ${NB} places, durée max ${MAX_MIN} min`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext(CONTEXT_OPTIONS);
  const p = await ctx.newPage();
  if (!(await login(p))) { log('Échec de connexion'); await browser.close(); process.exit(1); }
  log('Connecté');
  await emptyCart(p);

  const deadline = Date.now() + MAX_MIN * 60000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      // On regarde Ouest France, puis Cholet Agglomération si pas de niveau 3/4 côte à côte
      let best = null, lastKey = null;
      for (const key of ['ouest', 'agglo']) {
        await openSection(p, key); lastKey = key;
        const { cands, nbFree } = await findCandidates(p);
        log(`#${attempt} ${TRIBUNE_NAMES[key]} : ${nbFree} libres, ${cands.length} groupes de ${NB} contigus`);
        if (cands.length && (!best || cands[0].tier < best.tier)) best = { ...cands[0], key };
        if (best && best.tier === 1 && best.key === key) break;
      }
      if (!best) { log('Aucun groupe disponible, nouvel essai'); await p.waitForTimeout(3000); continue; }
      // La tribune ouverte doit être celle du meilleur candidat (rechargement seulement si besoin)
      if (best.key !== lastKey) await openSection(p, best.key);
      const { cands } = best.key !== lastKey ? await findCandidates(p) : { cands: [best] };
      const cand = cands.find(c => c.seats[0].id === best.seats[0].id) || cands[0];
      if (!cand) continue;
      const desc = `${TRIBUNE_NAMES[best.key]} - ${cand.cat} - rang ${cand.seats[0].rang} places ${cand.seats.map(s => s.num).join(', ')}`;
      log('Tentative :', desc);
      const res = await tryAdd(p, cand);
      if (res && res.dry) { log('Dry-run terminé avec succès'); break; }
      const ok = res && res.cart2 && res.cart2.success && res.cart2.success['11939139'];
      log('Réponse ajout :', ok ? `${ok.nbPlaces} place(s) acceptée(s)` : 'refus / pas de réponse');
      // Vérification dans le panier
      await p.goto(URL_EVT, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2500);
      const cart = await cartInfo(p);
      const allIn = cand.seats.every(s => new RegExp(`Rang ${s.rang} Place ${s.num}\\b`).test(cart.text));
      log(`Panier : ${cart.n} place(s), sièges attendus présents : ${allIn}, délai : ${cart.timer || '?'}`);
      if (cart.n === NB && allIn) {
        const total = (cart.text.match(/Montant total : ([\d,]+ €)/) || [0, '?'])[1];
        const msg = `✅ ${NB} places au panier Seetickets (Cholet - Dijon, 07/11/2026)\n${desc}\nTotal : ${total}\nTemps restant : ${cart.timer || '15 min'}\n` +
          `Pour récupérer le panier : ouvrir billetterie.seetickets.fr, lancer le favori « Panier Seetickets » et coller le code du message suivant.`;
        log('SUCCÈS', desc);
        telegram(msg);
        // Code seul dans son propre message pour le copier facilement ; jamais écrit dans les logs
        telegram(await handoverCode(ctx));
        // On garde la session ouverte jusqu'à l'expiration du panier
        log('Session maintenue ouverte 15 min');
        await p.waitForTimeout(15 * 60000);
        break;
      }
      if (cart.n > 0) await emptyCart(p);  // panier partiel ou incohérent : on vide et on recommence
      await p.waitForTimeout(1500);
    } catch (e) {
      log(`#${attempt} erreur : ${e.message.split('\n')[0]}`);
      await p.waitForTimeout(3000);
    }
  }
  if (Date.now() >= deadline) { log('Délai max atteint sans succès'); telegram('❌ Seetickets : pas réussi à obtenir 2 places côte à côte dans le délai.'); }
  await browser.close();
})();
