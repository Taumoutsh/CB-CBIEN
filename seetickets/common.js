const { chromium } = require('playwright');
const URL_EVT = "https://billetterie.seetickets.fr/dijon-sport-espace-michel-leger-parc-de-la-meilleraie-cholet-07-novembre-2026-css5-choletbasket-pg101-ri11939139.html";
// Positions (coords du plan 3D) des tribunes ; sel = valeur dans la liste #idTribune de la version mobile
const TRIBUNES = { ouest: { x: 480, y: 200, id: 58463, sel: '8913' }, agglo: { x: 200, y: 371, id: 58465, sel: '8911' } };
// --mobile : navigation en iPhone, le panier est alors créé sur la version mobile du site
// (session distincte de la version ordinateur) et récupérable depuis un téléphone
const MOBILE = process.argv.includes('--mobile');
const CONTEXT_OPTIONS = MOBILE
  ? { locale: 'fr-FR', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }
  : { locale: 'fr-FR', viewport: { width: 1280, height: 1000 } };
// Le site redéfinit window.Map : on évite les helpers Playwright qui en dépendent
async function poll(p, expr, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await p.evaluate(expr)) return; await p.waitForTimeout(30); }
  throw new Error('timeout: ' + expr);
}
const RS = `Map.instances['mapRoom_default-2'].plugins['MapRoomSection']`;
const CANVAS_READY = `(()=>{try{return !!document.getElementById('mapRoom_default-2-MapRoomSection-canvasHolder-canvas-canvas') && Object.keys(${RS}.seatsRegister).length>0}catch(e){return false}})()`;
// Sièges libres dont le tarif est connu : 0 tant que les statuts ne sont pas appliqués
const PRICED_FREE = `(()=>{const rs=${RS};let s=0;for(const c in rs.seatsRegister){const d=rs.getSeatData(rs.seatsRegister[c]);if(d&&d.selectable&&(rs.getSeatProps(d.id)||{}).pricesGroupId)s++;}return s})()`;
// Compte les chargements de statuts (événement du plan) pour savoir quand un rafraîchissement est appliqué
const HOOK_STATES = `(()=>{const rs=${RS};if(rs.__hooked)return;const f=rs.rmtRoomSectionStatesLoaded;
  rs.rmtRoomSectionStatesLoaded=function(){const r=f.apply(this,arguments);window.__statesN=(window.__statesN||0)+1;return r};rs.__hooked=1})()`;
// Bandeau cookies : cliqué seulement s'il est affiché (il ne réapparaît plus une fois accepté ; l'attendre coûtait 30 s par essai)
async function acceptCookies(p) {
  const ok = p.getByText('OK', { exact: true });
  if (await ok.isVisible().catch(() => false)) await ok.click().catch(() => {});
}
// Ouvre le plan de la tribune et attend les statuts des sièges ; attentes par sondage plutôt que délais fixes
async function openSection(p, key) {
  await p.goto(URL_EVT, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await acceptCookies(p);
  const t = TRIBUNES[key];
  if (MOBILE) {
    await poll(p, `(document.querySelector('#idTribune')||{options:[]}).options.length>1`, 15000);
    await p.selectOption('#idTribune', t.sel);
  } else {
    // L'image du plan est remplacée pendant le chargement : position recalculée à chaque survol,
    // jusqu'à ce que la zone cliquable de la tribune apparaisse
    const img = p.locator('img[usemap*="MapGlobal3D"]');
    const end = Date.now() + 20000;
    for (;;) {
      if (Date.now() > end) throw new Error('plan 3D non prêt');
      await img.scrollIntoViewIfNeeded({ timeout: 500 }).catch(() => {});
      const box = await img.boundingBox().catch(() => null);
      if (box) {
        await p.mouse.move(box.x + t.x + 1, box.y + t.y); await p.mouse.move(box.x + t.x, box.y + t.y);
        if (await p.evaluate(`!!document.querySelector('area[href="#${t.id}"]')`)) { await p.mouse.click(box.x + t.x, box.y + t.y); break; }
      }
      await p.waitForTimeout(100);
    }
  }
  await poll(p, CANVAS_READY, 20000);
  await p.evaluate(HOOK_STATES);
  await poll(p, `(window.__statesN||0)>0 || ${PRICED_FREE}>0`, 20000);
}
// Recharge les statuts des sièges sans recharger la page (≈ 1 s au lieu de ≈ 7 s)
async function refreshSection(p) {
  const n = await p.evaluate('window.__statesN||0');
  await p.evaluate(`${RS}.rmtRefresh()`);
  await poll(p, `(window.__statesN||0)>${n}`, 15000);
}
module.exports = { poll, chromium, URL_EVT, TRIBUNES, MOBILE, CONTEXT_OPTIONS, openSection, refreshSection, acceptCookies };
// Connexion via « Mon compte » ; identifiants lus depuis l'environnement, jamais affichés
async function login(p) {
  await p.goto(URL_EVT, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.getByText('OK', { exact: true }).click({ timeout: 5000 }).catch(()=>{});
  await p.locator('text=Mon compte >> visible=true').first().click();
  await p.locator('#dejamail').waitFor();
  await p.fill('#dejamail', process.env.SEETICKETS_EMAIL);
  await p.fill('#dejapass', process.env.SEETICKETS_PASSWORD);
  await Promise.all([p.waitForLoadState('domcontentloaded'), p.click('#formSubmit')]);
  await p.waitForTimeout(3000);
  return /Bonjour/.test(await p.evaluate('document.body.textContent'));
}
async function cartText(p) {
  return p.evaluate(`(()=>{const e=document.querySelector('.compPanierDropDown')||document.querySelector('#compPanier1'); return e? e.textContent.replace(/\\s+/g,' ').trim() : 'pas de panier'})()`);
}
module.exports.login = login; module.exports.cartText = cartText;
