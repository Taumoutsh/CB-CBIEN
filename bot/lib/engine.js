// Socle commun des moteurs de recherche (une classe Hunt par billetterie, dans sources/) : rythmes, attente de
// l'ouverture, état affiché par /statut, annulation.
//
// Contrat d'un moteur (utilisé par bot.js et cli.js) :
//   new Hunt({ club, url, date, team, openAt, places, dryRun, events })
//   run() → 'kept' (places gardées) | 'cancelled' | 'dry' (essai sans réservation) ; cancel()
//   state.phase : attente | préparation | ouverture | recherche | proposition | terminé
//   refused (Set des places refusées), places (modifiable en cours de route), matchLabel (nom trouvé sur la billetterie)
//   events.info(texte) ; events.proposal(proposition) → Promise<'keep' | 'refuse' | 'expired' | 'cancel'>
// Proposition : { desc, timing, expiresAt, link, linkText, released, renewal, renewNext, image() → chemin d'un PNG }
//   released : 'now' si refuser libère les places tout de suite, 'expiry' si elles restent bloquées jusqu'à expiration.
//   renewal : n° de la reprise de ces places (0 la première fois) ; renewNext : n° de la reprise prévue si la
//   proposition expire sans réponse (0 : plus de reprise, places écartées) ; renewMax : reprises au plus (0 : aucune).
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

const TIMING = {
  prepMs: +env('PREPARATION_MIN', '3') * 60000,          // démarrage du navigateur avant l'heure d'ouverture
  fastWindowMs: +env('FENETRE_RAPIDE_MIN', '5') * 60000, // durée du rythme rapide après l'ouverture (et après un refus)
  fastMs: +env('RYTHME_RAPIDE_MS', '500'),               // pause entre deux tours en rythme rapide
  slowMs: +env('VEILLE_S', '10') * 1000,                 // pause quand aucune place ne convient, hors rythme rapide
  // Panier expiré sans réponse : mêmes places reprises aussitôt, au plus REPRISES_PANIER fois (0 = jamais), puis
  // écartées pour ce match : pas de blocage indéfini de places non payées
  renewMax: Math.max(0, +env('REPRISES_PANIER', '4')),
  renewWaitMs: 2 * 60000,                                // attente maximale de leur libération par le site
};

const fmtSecs = ms => (ms / 1000).toFixed(1).replace('.', ',');
// Durées cumulées { étape: ms } → « page 6,1 · grille 2,7 · … » (durée de chaque étape)
const steps = laps => { let prev = 0; return Object.entries(laps).map(([k, v]) => { const d = v - prev; prev = v; return `${k} ${fmtSecs(d)}`; }).join(' · '); };
const euros = cents => `${(cents / 100).toFixed(2).replace('.', ',').replace(',00', '')} €`;

class BaseHunt {
  constructor({ club, url, date, team, openAt, places = 2, dryRun = false, events }) {
    this.club = club; this.rules = club.rules;
    this.url = url || null; this.date = date || null; this.team = team || null;
    this.target = team ? `contre ${team}${date ? ` du ${date.label}` : ''}` : date ? `du ${date.label}` : '';
    this.openAt = openAt; this.places = places; this.dryRun = dryRun;
    this.events = events; this.cancelled = false; this.refused = new Set();
    this.state = { phase: 'attente', detail: '' };
    this.matchLabel = null;
    this.expiries = new Map();  // place → nombre de propositions expirées sans réponse
    this.renew = null;          // reprise en cours : { ids, n, until }
    this.renewWaitMs = TIMING.renewWaitMs;  // attente de la libération des places par le site (selon la billetterie)
    this.renewMax = TIMING.renewMax;        // reprises au plus (0 : pas de reprise pour cette billetterie)
  }

  // ─── Reprise des places d'un panier expiré ───
  // N° de la reprise qui suivrait l'expiration de ces places (0 : limite atteinte)
  renewNext(seats) {
    const n = Math.max(0, ...seats.map(s => this.expiries.get(String(s.id)) || 0)) + 1;
    return n <= this.renewMax ? n : 0;
  }
  // Proposition expirée sans réponse : reprise des mêmes places, ou places écartées si la limite est atteinte
  expired(seats) {
    if (!this.renewMax) return;  // pas de reprise : recherche normale, places non écartées
    const n = this.renewNext(seats);
    for (const s of seats) this.expiries.set(String(s.id), (this.expiries.get(String(s.id)) || 0) + 1);
    if (n) { this.renew = { ids: seats.map(s => String(s.id)), n, until: Date.now() + this.renewWaitMs }; this.log(`Reprise ${n}/${this.renewMax} des places expirées`); }
    else { seats.forEach(s => this.refused.add(s.id)); this.renew = null; this.log(`Limite de ${this.renewMax} reprises atteinte : places écartées`); }
  }
  // Reprise en attente (null si aucune, ou si les places ne sont pas redevenues libres à temps)
  renewing() {
    if (this.renew && Date.now() > this.renew.until) { this.log('Places expirées non libérées à temps : recherche normale'); this.renew = null; }
    return this.renew;
  }
  // Groupe de la reprise parmi des sièges { id, free } : les mêmes places, toutes libres, sinon null
  renewGroup(seats) {
    const r = this.renewing();
    if (!r) return null;
    if (r.ids.length !== this.places) { this.renew = null; return null; }  // nombre de places changé (/places)
    const grp = r.ids.map(id => seats.find(s => String(s.id) === id));
    return grp.every(s => s && s.free) ? grp : null;
  }

  cancel() { this.cancelled = true; }

  log(...a) { console.log(new Date().toISOString().slice(11, 19), `[${this.club.id}]`, ...a); }

  setState(phase, detail = '') { this.state = { phase, detail, at: Date.now() }; }

  // Pause interrompue dès l'annulation
  async sleep(ms) {
    const end = Date.now() + ms;
    while (!this.cancelled && Date.now() < end) await new Promise(r => setTimeout(r, Math.min(250, end - Date.now())));
  }

  // Attente jusqu'à peu avant l'ouverture ; false si annulé entre-temps
  async waitOpening() {
    while (!this.cancelled && Date.now() < this.openAt - TIMING.prepMs) {
      this.setState('attente');
      await this.sleep(Math.min(30000, this.openAt - TIMING.prepMs - Date.now()));
    }
    return !this.cancelled;
  }

  // Pause entre deux relectures de la billetterie tant que le match n'est pas trouvé ou pas en vente : 3 s avant
  // l'ouverture, rythme rapide pendant FENETRE_RAPIDE_MIN après, puis VEILLE_S (la billetterie n'est pas sollicitée
  // toutes les 0,5 s indéfiniment si le match n'apparaît pas)
  pollDelay() {
    const now = Date.now();
    return now < this.openAt ? 3000 : now < this.openAt + TIMING.fastWindowMs ? TIMING.fastMs : TIMING.slowMs;
  }

  // « ⏱ 2,1 s · ouverture +0:05 » : temps de réservation (détection → confirmation) et délai depuis l'ouverture
  timing(t0, added, tStart) {
    const since = Math.round((added - Math.max(tStart, this.openAt)) / 1000);
    return `⏱ ${fmtSecs(added - t0)} s` + (this.openAt <= added ? ` · ouverture +${Math.floor(since / 60)}:${String(since % 60).padStart(2, '0')}` : '');
  }
}

module.exports = { BaseHunt, TIMING, env, fmtSecs, steps, euros };
