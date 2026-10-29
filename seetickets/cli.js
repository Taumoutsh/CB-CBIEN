// Lancement manuel sans Telegram, pour tester :
// node cli.js <lien> | --date="7 novembre 2026"  [--dry-run] [--places=2] [--ouverture="01/12 15:00"] [--decision=refuse,keep] [--image=dossier]
// Les propositions sont résolues dans l'ordre de --decision (la dernière se répète ; keep par défaut) ;
// --image enregistre l'image de chaque proposition. Le code n'est jamais affiché.
const { Hunt, parseOpening, parseMatchDate } = require('./hunt');
const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const url = args.find(a => !a.startsWith('--'));
const openAt = parseOpening(opt('ouverture', 'maintenant'));
const date = opt('date', null) && parseMatchDate(opt('date'));
if (!(url || date) || !openAt) { console.error('Usage : node cli.js <lien> | --date="7 novembre 2026" [--dry-run] [--places=2] [--ouverture="01/12 15:00"] [--decision=refuse,keep] [--image=dossier]'); process.exit(1); }
const decisions = opt('decision', 'keep').split(',');
const imageDir = opt('image', null);
let n = 0;
const hunt = new Hunt({
  url, date, openAt: openAt.getTime(), places: +opt('places', '2'), dryRun: args.includes('--dry-run'),
  events: {
    info: t => console.log('[info]', t),
    proposal: async p => {
      const decision = decisions[Math.min(n++, decisions.length - 1)];
      console.log('[proposition]', p.desc, '|', p.timing, '→', decision);
      if (imageDir) { const f = await p.image(); require('fs').renameSync(f, require('path').join(imageDir, `proposition-${n}.png`)); }
      return decision;
    },
  },
});
process.on('SIGINT', () => hunt.cancel());
hunt.run().then(r => { console.log('Résultat :', r); process.exit(0); }, e => { console.error(e); process.exit(1); });
