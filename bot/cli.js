// Lancement manuel sans Telegram, pour tester :
// node cli.js [--club=hockey] <lien> | --date="7 novembre 2026" | --equipe=Dijon  [--dry-run] [--places=2] [--ouverture="01/12 15:00"] [--decision=refuse,keep] [--image=dossier]
// Club par défaut : le premier des clubs suivis (basket). Les propositions sont résolues dans l'ordre de --decision
// (la dernière se répète ; keep par défaut) ; --image enregistre l'image de chaque proposition. Le lien du panier ou
// du paiement n'est jamais affiché.
const { parseOpening, parseMatchDate } = require('./lib/dates');
const { CLUBS, clubByAlias, clubOfUrl } = require('./clubs');
const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const url = args.find(a => !a.startsWith('--'));
const club = url ? clubOfUrl(url) : opt('club') ? clubByAlias(opt('club')) : CLUBS[0];
const openAt = parseOpening(opt('ouverture', 'maintenant'));
const date = opt('date', null) && parseMatchDate(opt('date'));
const team = opt('equipe', null);
if (!club || !(url || date || team) || !openAt) { console.error('Usage : node cli.js [--club=hockey] <lien> | --date="7 novembre 2026" | --equipe=Dijon [--dry-run] [--places=2] [--ouverture="01/12 15:00"] [--decision=refuse,keep] [--image=dossier]'); process.exit(1); }
const dryRun = args.includes('--dry-run');
const missing = club.src.missingSettings(club);
if (missing.length && !dryRun) { console.error(`Réglages manquants pour ${club.name} : ${missing.join(', ')}`); process.exit(1); }
const decisions = opt('decision', 'keep').split(',');
const imageDir = opt('image', null);
let n = 0;
const hunt = new club.src.Hunt({
  club, url, date, team, openAt: openAt.getTime(), places: +opt('places', '2'), dryRun,
  events: {
    info: t => console.log('[info]', t),
    proposal: async p => {
      const decision = decisions[Math.min(n++, decisions.length - 1)];
      console.log('[proposition]', p.desc, '|', p.timing, '| expire', new Date(p.expiresAt).toLocaleTimeString('fr-FR'), '→', decision);
      if (imageDir) {
        const f = await p.image(); require('fs').renameSync(f, require('path').join(imageDir, `proposition-${n}.png`));
        if (p.venue) { const g = await p.venue(); require('fs').renameSync(g, require('path').join(imageDir, `proposition-${n}-salle.png`)); }
      }
      return decision;
    },
  },
});
console.log(`${club.name} (${club.src.name})`);
process.on('SIGINT', () => hunt.cancel());
hunt.run().then(r => { console.log('Résultat :', r); process.exit(0); }, e => { console.error(e); process.exit(1); });
