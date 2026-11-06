// Navigateur commun : Chromium (Playwright) avec le profil d'un iPhone. Les versions mobiles des billetteries sont
// celles qu'on reprend ensuite sur le téléphone pour payer.
const { chromium } = require('playwright');

const CONTEXT_OPTIONS = {
  locale: 'fr-FR', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  extraHTTPHeaders: { 'accept-language': 'fr-FR,fr;q=0.9' },
};

module.exports = { chromium, CONTEXT_OPTIONS };
