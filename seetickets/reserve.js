// Réservation de 2 places côte à côte (Ouest France ou Cholet Agglomération), sans paiement.
// Usage : node reserve.js [--dry-run] [--mobile] [--max-minutes=N] [--places=2] [--interval=ms]
// Identifiants : SEETICKETS_EMAIL / SEETICKETS_PASSWORD ; Telegram : TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.
// Rien de sensible n'est écrit dans un fichier ou un log.
const { execFileSync } = require('child_process');
const { chromium, openSection, refreshSection, login, poll, URL_EVT, MOBILE, CONTEXT_OPTIONS } = require('./common');
const { handoverCode } = require('./handover');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const MAX_MIN = +(args.find(a => a.startsWith('--max-minutes=')) || '=30').split('=')[1];
const NB = +(args.find(a => a.startsWith('--places=')) || '=2').split('=')[1];
// Pause entre deux rafraîchissements des plans (en plus du ≈ 1 s du rafraîchissement lui-même)
const INTERVAL = +(args.find(a => a.startsWith('--interval=')) || '=500').split('=')[1];
// Rechargement complet des plans de temps en temps, au cas où la page se fige
const RELOAD_MS = 10 * 60000;
const KEYS = ['ouest', 'agglo'];  // ordre de préférence à niveau égal

// Groupes de tarifs (pricesGroupId) : priorité 1 = niveaux 3/4 bancs, priorité 2 = niveau 2
const GROUPS = {
  2693567: { name: 'NIVEAU 3 BANCS', tier: 1 },
  2693571: { name: 'NIVEAU 4 BANCS', tier: 1 },
  2693557: { name: 'NIVEAU 2 BANCS', tier: 2 },
  2693565: { name: 'NIVEAU 2 FAUTEUILS', tier: 2 },
};
const TRIBUNE_NAMES = { ouest: 'TRIBUNE OUEST FRANCE', agglo: 'TRIBUNE CHOLET AGGLOMERATION' };

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// secret : le texte (code de session) n'apparaît jamais dans les logs
function telegram(text, secret = false) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { log('Telegram non configuré (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) :', secret ? '(code masqué)' : text); return false; }
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

// Le composant panier est d'abord un simple script, son contenu arrive ≈ 0,6 s plus tard
const CART_READY = `/Panier \\(\\d+\\)|Nombre d'articles|panier est vide/.test((document.querySelector('#compPanier1')||{}).textContent||'')`;

async function cartInfo(p) {
  const t = await p.evaluate(`(()=>{const e=document.querySelector('#compPanier1'); return e? e.textContent.replace(/\\s+/g,' ').trim() : ''})()`);
  // « Panier (2) » sur la version ordinateur, « Nombre d'articles : 2 » sur la version mobile
  const n = (t.match(/Panier \((\d+)\)|Nombre d'articles : (\d+)/) || []).slice(1).find(Boolean) || 0;
  const timer = (t.match(/Il vous reste ([^.]*) pour valider/) || [0, ''])[1];
  return { n: +n, text: t, timer };
}

async function emptyCart(p) {
  await p.goto(URL_EVT, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await poll(p, CART_READY, 10000).catch(() => {});
  if ((await cartInfo(p)).n === 0) return;
  log('Vidage du panier partiel…');
  // Même action que le lien « Vider le panier », masqué dans le détail replié (versions ordinateur et mobile)
  await p.evaluate(`compPanier1.viderPanier()`).catch(e => log('Vider KO', e.message.split('\n')[0]));
  await p.waitForTimeout(800);
  // Éventuelle confirmation (jquery.alerts / impromptu)
  for (const sel of ['#popup_ok', '#jqibox button:has-text("OK")', '#jqibox button:has-text("Oui")', '#jqibox input[value="OK"]'])
    await p.locator(sel).first().click({ timeout: 300 }).catch(() => {});
  await p.waitForTimeout(1500);
  await p.goto(URL_EVT, { waitUntil: 'domcontentloaded' });
  await poll(p, CART_READY, 10000).catch(() => {});
  log('Panier après vidage :', (await cartInfo(p)).n, 'place(s)');
}

// Tente d'ajouter le groupe de sièges ; renvoie la réponse « add » du serveur (ou null)
async function tryAdd(p, cand) {
  await p.evaluate(`(()=>{const rs=Map.instances['mapRoom_default-2'].plugins['MapRoomSection']; rs.select(${JSON.stringify(cand.seats.map(s => s.cellId))}, true);})()`);
  await poll(p, `document.querySelector('#validateButton').textContent.includes('(${NB})')`, 2000)
    .catch(async () => log('Sélection incorrecte :', await p.locator('#validateButton').innerText()));
  if (!(await p.locator('#validateButton').innerText()).includes(`(${NB})`)) return null;
  await p.locator('#validateButton').click();
  await p.locator('#PricesSelector input.addToCart').waitFor({ timeout: 10000 });
  // Plein tarif pour chaque siège
  let tarifs = [];
  for (let i = 0; i < 60 && tarifs.length < NB; i++) {
    if (i) await p.waitForTimeout(50);
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
  if (body && body.cart2 && body.cart2.success) return body;
  await p.waitForTimeout(500);
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

  // Un onglet par tribune, ouvert une fois ; ensuite on ne fait que rafraîchir les statuts des sièges
  const pages = { ouest: p, agglo: await ctx.newPage() };
  const opened = {};
  const open = async key => { await openSection(pages[key], key); opened[key] = Date.now(); };
  await Promise.all(KEYS.map(open));
  log('Plans ouverts');

  const deadline = Date.now() + MAX_MIN * 60000;
  let attempt = 0, done = false, lastStatus = '';
  while (Date.now() < deadline) {
    attempt++;
    const t0 = Date.now();
    try {
      await Promise.all(KEYS.map(k => Date.now() - opened[k] > RELOAD_MS ? open(k) : refreshSection(pages[k])));
      // Ouest France prioritaire, Cholet Agglomération si elle offre un meilleur niveau
      let best = null; const status = [];
      for (const key of KEYS) {
        const { cands, nbFree } = await findCandidates(pages[key]);
        status.push(`${TRIBUNE_NAMES[key]} : ${nbFree} libres, ${cands.length} groupes`);
        if (cands.length && (!best || cands[0].tier < best.tier)) best = { ...cands[0], key };
      }
      // Journal seulement quand la situation change (un tour par seconde environ)
      if (status.join(' | ') !== lastStatus) { lastStatus = status.join(' | '); log(`#${attempt} ${lastStatus} (${Date.now() - t0} ms)`); }
      if (!best) { await p.waitForTimeout(INTERVAL); continue; }
      const page = pages[best.key];
      const desc = `${TRIBUNE_NAMES[best.key]} - ${best.cat} - rang ${best.seats[0].rang} places ${best.seats.map(s => s.num).join(', ')}`;
      log('Tentative :', desc);
      const res = await tryAdd(page, best);
      if (res && res.dry) { done = true; log(`Dry-run terminé avec succès (essai en ${((Date.now() - t0) / 1000).toFixed(1)} s)`); break; }
      const ok = res && res.cart2 && res.cart2.success && res.cart2.success['11939139'];
      log('Réponse ajout :', ok ? `${ok.nbPlaces} place(s) acceptée(s)` : 'refus / pas de réponse', `(essai en ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      if (ok && ok.nbPlaces === NB) {
        // Le serveur a confirmé les places : on prévient tout de suite, la vérification du panier vient après
        const msg = `✅ ${NB} places au panier Seetickets (Cholet - Dijon, 07/11/2026)\n${desc}\nValable 15 min${MOBILE ? '' : ' (sur téléphone : « site pour ordinateur »)'}\n` +
          `Ouvrir billetterie.seetickets.fr, lancer le favori « Panier Seetickets » et coller le code du message suivant.`;
        log('SUCCÈS', desc);
        telegram(msg);
        // Code seul dans son propre message pour le copier facilement ; jamais écrit dans les logs
        telegram(await handoverCode(ctx), true);
        await page.goto(URL_EVT, { waitUntil: 'domcontentloaded' });
        await poll(page, CART_READY, 10000).catch(() => {});
        const cart = await cartInfo(page);
        const allIn = best.seats.every(s => new RegExp(`Rang ${s.rang} Place ${s.num}\\b`).test(cart.text));
        log(`Panier : ${cart.n} place(s), sièges attendus présents : ${allIn}, délai : ${cart.timer || '?'}, total : ${(cart.text.match(/Montant total : ([\d,]+ €)/) || [0, '?'])[1]}`);
        if (cart.n !== NB || !allIn) telegram(`⚠️ Le panier du script ne montre pas les places attendues (${cart.n} place(s)). Vérifier après récupération.`);
        // On garde la session ouverte jusqu'à l'expiration du panier
        log('Session maintenue ouverte 15 min');
        await page.waitForTimeout(15 * 60000);
        done = true;
        break;
      }
      // Refus explicite (places prises entre-temps) : rien à rouvrir, le rafraîchissement suivant efface la sélection.
      // Panier partiel ou réponse illisible (l'ajout a pu passer) : on vide le panier et on rouvre les plans concernés
      // (emptyCart navigue dans l'onglet Ouest France).
      if (ok || !res) { await emptyCart(pages.ouest); opened.ouest = 0; opened[best.key] = 0; }
    } catch (e) {
      log(`#${attempt} erreur : ${e.message.split('\n')[0]}`);
      KEYS.forEach(k => { opened[k] = 0; });  // rechargement complet au tour suivant
      await p.waitForTimeout(1000);
    }
  }
  if (!done) { log('Délai max atteint sans succès'); if (!DRY) telegram('❌ Seetickets : pas réussi à obtenir 2 places côte à côte dans le délai.'); }
  await browser.close();
})();
