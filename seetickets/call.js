// Appel Telegram via CallMeBot (service tiers, gratuit) : sonne comme un appel Telegram et lit un texte à voix haute.
// À faire une fois : envoyer /start à @CallMeBot_txtbot depuis le compte Telegram à appeler.
// CALLMEBOT_USER : @pseudo Telegram (ou numéro au format international) ; absent = pas d'appel.
const { execFile } = require('child_process');

const configured = () => !!process.env.CALLMEBOT_USER;

// Un essai : { ok, busy, detail }. busy = service saturé (« too many requests »), à réessayer plus tard
function attempt(text) {
  const q = new URLSearchParams({
    user: process.env.CALLMEBOT_USER,
    text: text.slice(0, 256),                              // le service coupe au-delà de 256 caractères
    lang: process.env.CALLMEBOT_LANG || 'fr-FR-Standard-A', // voix Google « Standard »
    rpt: '2',                                              // message lu deux fois
    cc: 'missed',                                          // copie écrite seulement si l'appel est manqué
  });
  return new Promise(resolve => {
    execFile('curl', ['-sS', '--max-time', '60', '-w', '\n%{http_code}', `https://api.callmebot.com/start.php?${q}`], (err, stdout) => {
      if (err) return resolve({ ok: false, busy: true, detail: String(err.message).split('\n')[0] });
      const status = +stdout.trim().split('\n').pop();
      // Réponse HTML : texte visible seulement (sans scripts), ex. « User not authorized. Click here to authorize… »
      const t = stdout.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().replace(/\s*\d{3}$/, '');
      const busy = status === 429 || status >= 500 || /too many|rate limit|try again|please wait|busy/i.test(t);
      resolve({ ok: !busy && status === 200 && !/error|not authori|invalid/i.test(t), busy, detail: t.slice(0, 200) || `HTTP ${status}` });
    });
  });
}

// Appel avec nouveaux essais espacés quand le service est saturé ; résout { ok, detail, tries } sans jamais échouer
// (l'appel ne doit pas gêner la réservation). onRetry(n, attente_s) : prévenir de chaque nouvel essai ;
// stillNeeded() faux : abandon (ex. proposition déjà traitée sur Telegram).
async function call(text, onRetry = () => {}, stillNeeded = () => true) {
  if (!configured()) return { ok: false, detail: 'CALLMEBOT_USER non défini', tries: 0 };
  const waits = [15, 30, 60, 120];  // ≈ 4 min au total
  let r;
  for (let i = 0; ; i++) {
    r = await attempt(text);
    if (r.ok || !r.busy || i === waits.length) return { ...r, tries: i + 1 };
    onRetry(i + 1, waits[i]);
    await new Promise(res => setTimeout(res, waits[i] * 1000));
    if (!stillNeeded()) return { ok: false, detail: 'abandonné : proposition déjà traitée', tries: i + 1, dropped: true };
  }
}

module.exports = { configured, call };
