// Client Telegram minimal, asynchrone : n'interrompt jamais la recherche de places.
// Passe par curl (proxy et certificats du système) ; le jeton est transmis par stdin (fichier de
// configuration curl), jamais en argument ni dans les logs.
const { execFile } = require('child_process');

const token = () => process.env.TELEGRAM_BOT_TOKEN;
const chatId = () => process.env.TELEGRAM_CHAT_ID;
const configured = () => !!(token() && chatId());

// Échappement d'une valeur entre guillemets dans un fichier de configuration curl
const q = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';

// Appel de l'API ; fields : valeurs texte ou objets (envoyés en JSON) ; files : { champ: chemin }
function api(method, fields = {}, { files = {}, timeoutS = 30 } = {}) {
  const lines = [`url = ${q(`https://api.telegram.org/bot${token()}/${method}`)}`, 'silent', 'show-error', `max-time = ${timeoutS + 10}`];
  const multipart = Object.keys(files).length > 0;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    // form-string / data-urlencode : la valeur n'est jamais interprétée comme un fichier (@, <)
    lines.push(multipart ? `form-string = ${q(`${k}=${val}`)}` : `data-urlencode = ${q(`${k}=${val}`)}`);
  }
  for (const [k, path] of Object.entries(files)) lines.push(`form = ${q(`${k}=@${path}`)}`);
  return new Promise(resolve => {
    const child = execFile('curl', ['-K', '-'], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ ok: false, description: 'curl : ' + String(err.message).split('\n')[0].replace(token() || '\0', '***') });
      try { resolve(JSON.parse(stdout)); } catch (e) { resolve({ ok: false, description: 'réponse illisible' }); }
    });
    child.stdin.end(lines.join('\n') + '\n');
  });
}

// buttons : [[{ text, data }]] (clavier en ligne)
const keyboard = buttons => buttons && { inline_keyboard: buttons.map(row => row.map(b => ({ text: b.text, callback_data: b.data }))) };

async function send(text, { buttons } = {}) {
  if (!configured()) return null;
  const r = await api('sendMessage', { chat_id: chatId(), text, reply_markup: keyboard(buttons), disable_web_page_preview: true });
  if (!r.ok) console.log('Telegram : échec envoi', r.description);
  return r.ok ? r.result : null;
}

async function sendPhoto(file, caption) {
  if (!configured()) return null;
  const r = await api('sendPhoto', { chat_id: chatId(), caption }, { files: { photo: file } });
  if (!r.ok) console.log('Telegram : échec image', r.description);
  return r.ok ? r.result : null;
}

// Remplace le texte d'un message (et retire ses boutons)
const edit = (messageId, text) => api('editMessageText', { chat_id: chatId(), message_id: messageId, text, disable_web_page_preview: true });
const answerCallback = (id, text) => api('answerCallbackQuery', { callback_query_id: id, text });
const getUpdates = (offset, timeoutS) => api('getUpdates', { offset, timeout: timeoutS, allowed_updates: ['message', 'callback_query'] }, { timeoutS });

module.exports = { configured, chatId, send, sendPhoto, edit, answerCallback, getUpdates };
