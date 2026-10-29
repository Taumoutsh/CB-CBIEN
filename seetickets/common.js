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
  while (Date.now() < end) { if (await p.evaluate(expr)) return; await p.waitForTimeout(250); }
  throw new Error('timeout: ' + expr);
}
async function openSection(p, key) {
  await p.goto(URL_EVT, { waitUntil: 'networkidle', timeout: 60000 });
  await p.getByText('OK', { exact: true }).click().catch(()=>{});
  const t = TRIBUNES[key];
  if (MOBILE) {
    await p.selectOption('#idTribune', t.sel);
    await poll(p, `!!document.getElementById('mapRoom_default-2-MapRoomSection-canvasHolder-canvas-canvas')`, 20000);
    await p.waitForTimeout(3000);
    return;
  }
  const img = p.locator('img[usemap*="MapGlobal3D"]');
  await img.scrollIntoViewIfNeeded();
  const box = await img.boundingBox();
  await p.mouse.move(box.x+t.x, box.y+t.y);
  await poll(p, `!!document.querySelector('area[href="#${t.id}"]')`, 15000);
  await p.mouse.click(box.x+t.x, box.y+t.y);
  await poll(p, `!!document.getElementById('mapRoom_default-2-MapRoomSection-canvasHolder-canvas-canvas')`, 20000);
  await p.waitForTimeout(3000);
}
module.exports = { poll, chromium, URL_EVT, TRIBUNES, MOBILE, CONTEXT_OPTIONS, openSection };
// Connexion via « Mon compte » ; identifiants lus depuis l'environnement, jamais affichés
async function login(p) {
  await p.goto(URL_EVT, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.getByText('OK', { exact: true }).click().catch(()=>{});
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
