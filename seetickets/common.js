// Actions navigateur sur la billetterie Seetickets (version mobile du site).
// La version mobile choisit la tribune par son nom dans une liste : fonctionne pour toutes les tribunes
// et tous les matchs, et le panier se récupère directement depuis un téléphone.
const { chromium } = require('playwright');

const CONTEXT_OPTIONS = {
  locale: 'fr-FR', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};

// Identifiant de la représentation (clé des réponses d'ajout au panier) : « ri11939139 » dans le lien du match
function eventId(url) {
  const m = String(url).match(/-ri(\d+)\.html/);
  if (!m || !/^https:\/\/billetterie\.seetickets\.fr\//.test(url)) throw new Error('lien de match Seetickets invalide');
  return m[1];
}

// Le site redéfinit window.Map : on évite les helpers Playwright qui en dépendent
async function poll(p, expr, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await p.evaluate(expr)) return; await p.waitForTimeout(30); }
  throw new Error('timeout: ' + expr.slice(0, 80));
}

const RS = `Map.instances['mapRoom_default-2'].plugins['MapRoomSection']`;
const CANVAS_READY = `(()=>{try{return !!document.getElementById('mapRoom_default-2-MapRoomSection-canvasHolder-canvas-canvas') && Object.keys(${RS}.seatsRegister).length>0}catch(e){return false}})()`;
// Compte les chargements de statuts des sièges (événement du plan) pour savoir quand ils sont appliqués
const HOOK_STATES = `(()=>{const rs=${RS};if(rs.__hooked)return;const f=rs.rmtRoomSectionStatesLoaded;
  rs.rmtRoomSectionStatesLoaded=function(){const r=f.apply(this,arguments);window.__statesN=(window.__statesN||0)+1;return r};rs.__hooked=1})()`;

// Bandeau cookies : cliqué seulement s'il est affiché (il ne réapparaît plus une fois accepté)
async function acceptCookies(p) {
  const ok = p.getByText('OK', { exact: true });
  if (await ok.isVisible().catch(() => false)) await ok.click().catch(() => {});
}

// Connexion via « Mon compte » ; identifiants lus depuis l'environnement, jamais affichés
async function login(p, url) {
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.getByText('OK', { exact: true }).click({ timeout: 5000 }).catch(() => {});
  await p.locator('text=Mon compte >> visible=true').first().click();
  await p.locator('#dejamail').waitFor();
  await p.fill('#dejamail', process.env.SEETICKETS_EMAIL);
  await p.fill('#dejapass', process.env.SEETICKETS_PASSWORD);
  await Promise.all([p.waitForLoadState('domcontentloaded'), p.click('#formSubmit')]);
  await p.waitForTimeout(3000);
  return /Bonjour/.test(await p.evaluate('document.body.textContent'));
}

// Tribunes proposées par la page du match : [{ value, name }]
async function listTribunes(p) {
  return JSON.parse(await p.evaluate(`(()=>{const s=document.querySelector('#idTribune');const r=[];if(!s)return '[]';
    for(let i=0;i<s.options.length;i++){const o=s.options[i];if(o.value!=='0')r.push({value:o.value,name:o.text.trim()})}return JSON.stringify(r)})()`));
}

// Ouvre le plan de la tribune dont le nom contient `key` et attend les statuts des sièges.
// Échoue tant que la vente n'est pas ouverte (pas de liste de tribunes).
async function openTribune(p, url, key) {
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await acceptCookies(p);
  await poll(p, `(document.querySelector('#idTribune')||{options:[]}).options.length>1`, 15000);
  const t = (await listTribunes(p)).find(o => o.name.toUpperCase().includes(key.toUpperCase()));
  if (!t) throw new Error(`tribune ${key} absente`);
  // Compteur installé avant le choix de la tribune : le premier chargement des statuts est compté aussi
  await poll(p, `(()=>{try{return !!${RS}}catch(e){return false}})()`, 15000);
  await p.evaluate(HOOK_STATES);
  await p.selectOption('#idTribune', t.value);
  await poll(p, CANVAS_READY, 20000);
  await poll(p, `(window.__statesN||0)>0`, 20000);
  return t.name;
}

// Recharge les statuts des sièges sans recharger la page (≈ 1 s au lieu de ≈ 7 s)
async function refreshSection(p) {
  const n = await p.evaluate('window.__statesN||0');
  await p.evaluate(`${RS}.rmtRefresh()`);
  await poll(p, `(window.__statesN||0)>${n}`, 15000);
}

// Sièges de la tribune ouverte (la ligne sans rang est l'en-tête de la grille), avec le nom et le prix
// plein tarif de chaque catégorie
async function readSeats(p) {
  return JSON.parse(await p.evaluate(`(()=>{
    const m = Map.instances['mapRoom_default-2'], rs = m.plugins['MapRoomSection'], md = m.plugins['MapRoomData'];
    const seats = [], groups = {};
    for (const c in rs.seatsRegister) {
      const d = rs.getSeatData(rs.seatsRegister[c]);
      if (!d || !d.rang) continue;
      const g = (rs.getSeatProps(d.id) || {}).pricesGroupId || null;
      if (g && !(g in groups)) {
        let name = '?', cents = 0;
        try {
          const gd = md.getPricesGroupData(g); name = gd.name;
          for (const id in gd.prices) { const pd = md.getPriceData(id); if (/PLEIN TARIF/.test(pd.customerTypeName)) cents = Math.max(cents, pd.cents); }
        } catch (e) {}
        groups[g] = { name, cents };
      }
      seats.push({ id: d.id, x: d.x, y: d.y, cellId: d.cellId, rang: d.rang, num: d.numero, free: !!d.selectable, g });
    }
    return JSON.stringify({ seats, groups });
  })()`));
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

async function loadCart(p, url) {
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await poll(p, CART_READY, 10000).catch(() => {});
  return cartInfo(p);
}

// Vide le panier ; renvoie le nombre de places restantes.
// Rapide : demande depuis la page déjà ouverte, sans rechargement ; la réponse du serveur à « action=sup »
// ({"panier":[]}) confirme que le panier est vide (≈ 0,7 s).
async function emptyCart(p, url) {
  if (!(await p.evaluate(`typeof compPanier1!=='undefined' && !!document.querySelector('#compPanier1')`).catch(() => false))) {
    if ((await loadCart(p, url)).n === 0) return 0;
  }
  const resp = p.waitForResponse(r => /action=sup/.test(r.request().postData() || ''), { timeout: 6000 }).catch(() => null);
  await p.evaluate('compPanier1.viderPanier()').catch(() => {});
  const r = await resp;
  try { if (r && JSON.parse(await r.text()).panier.length === 0) return 0; } catch (e) {}
  return (await loadCart(p, url)).n;  // pas de confirmation : vérification par rechargement
}

module.exports = { chromium, CONTEXT_OPTIONS, eventId, poll, acceptCookies, login, listTribunes, openTribune, refreshSection, readSeats, cartInfo, loadCart, emptyCart };
