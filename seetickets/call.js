// Appel Telegram via CallMeBot (service tiers, gratuit) : sonne comme un appel Telegram et lit un texte à voix haute.
// À faire une fois : envoyer /start à @CallMeBot_txtbot depuis le compte Telegram à appeler.
// CALLMEBOT_USER : @pseudo Telegram (ou numéro au format international) ; absent = pas d'appel.
const { execFile } = require('child_process');

const configured = () => !!process.env.CALLMEBOT_USER;

// Résout { ok, detail } ; n'échoue jamais (l'appel ne doit pas gêner la réservation)
function call(text) {
  if (!configured()) return Promise.resolve({ ok: false, detail: 'CALLMEBOT_USER non défini' });
  const q = new URLSearchParams({
    user: process.env.CALLMEBOT_USER,
    text: text.slice(0, 256),                              // le service coupe au-delà de 256 caractères
    lang: process.env.CALLMEBOT_LANG || 'fr-FR-Standard-A', // voix Google « Standard »
    rpt: '2',                                              // message lu deux fois
    cc: 'missed',                                          // copie écrite seulement si l'appel est manqué
  });
  return new Promise(resolve => {
    execFile('curl', ['-sS', '--max-time', '60', `https://api.callmebot.com/start.php?${q}`], (err, stdout) => {
      if (err) return resolve({ ok: false, detail: String(err.message).split('\n')[0] });
      // Réponse HTML : texte visible seulement (sans scripts), ex. « User not authorized. Click here to authorize… »
      const t = stdout.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      resolve({ ok: !/error|not authori|invalid/i.test(t), detail: t.slice(0, 200) });
    });
  });
}

module.exports = { configured, call };
