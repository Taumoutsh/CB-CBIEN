// Moteur Weezevent (Ducs d'Angers) : attend l'ouverture de la vente, lit les sièges des zones voulues, réserve le
// meilleur groupe conforme et propose la page de paiement de la commande (Garder / Refuser).
//
// Comme Billetweb, le bot remplit les coordonnées de l'acheteur et le téléphone reprend la commande par sa page de
// paiement. Particularités : la sélection se fait dans le plan 3D du site (plus lente : quelques secondes par siège), et
// l'API du plan montre encore « disponibles » les sièges réservés par d'autres paniers : un refus du site au moment de
// « SUITE » écarte ces sièges pendant la durée d'un panier.
const { chromium, CONTEXT_OPTIONS } = require('../../lib/browser');
const { BaseHunt, TIMING, fmtSecs } = require('../../lib/engine');
const { norm, sameDate, teamMatches } = require('../../lib/dates');
const { geometry, inZone, rowGroups, predilection, byPredilection, seatMapImage } = require('../../lib/seats');
const { listEvents, Session } = require('./shop');

const HOLD_MS = 10 * 60000;  // durée d'un panier : sièges refusés par le site écartés pendant ce temps

// Groupes conformes de toutes les zones, du meilleur au moins bon : zone préférée (ordre de rules.zones), puis la zone
// de prédilection de la zone (au hasard dedans, puis l'axe central, puis les côtés). Pas de siège isolé laissé libre.
function candidates(zones, places, skip, rules) {
  const tier = z => rules.zones.findIndex(k => norm(z.name).includes(norm(k)));
  const out = [];
  for (const { zone, seats } of zones) {
    if (!seats.length) continue;
    const geo = geometry(seats), ok = inZone(geo, rules);
    for (const grp of rowGroups(seats, places, s => s.free && !skip(s.id) && ok(s), { gap: geo.unit * 1.6 }))
      out.push({ zone, seats: grp, all: seats, tier: tier(zone), ...predilection(geo, rules, grp) });
  }
  return out.sort((a, b) => a.tier - b.tier || byPredilection(a, b));
}

class Hunt extends BaseHunt {
  constructor(o) { super(o); this.blocked = new Map(); }  // sièges refusés par le site → heure de fin d'écart

  async run() {
    try { return await this.loop(); } finally { if (this.browser) await this.browser.close().catch(() => {}); }
  }

  skip(id) { const t = this.blocked.get(id); return this.refused.has(id) || (t && t > Date.now()); }

  // Le match sur la billetterie : par sa date, sinon par le nom de l'adversaire
  async findEvent(request) {
    this.setState('ouverture', `recherche du match ${this.target} sur la billetterie`);
    while (!this.cancelled) {
      try {
        const events = await listEvents(request, this.club.widgets);
        let found = this.date ? events.filter(e => sameDate(e.date, this.date)) : [];
        if (!found.length && this.team) found = events.filter(e => teamMatches(this.team, e.opponent));
        if (found.length) {
          const e = found[0];
          if (found.length > 1) this.events.info(`ℹ️ ${found.length} matchs ${this.target} : choix de ${e.name}.`);
          this.url = e.url; this.matchLabel = e.opponent;
          this.log('Match trouvé :', e.name, e.url);
          return true;
        }
      } catch (e) { this.log('billetterie :', e.message.split('\n')[0]); }
      if (!this.waitAnnounced && Date.now() >= this.openAt) { this.events.info('⏳ Pas encore en vente, surveillance en cours.'); this.waitAnnounced = true; }
      await this.sleep(Date.now() < this.openAt ? 3000 : TIMING.fastMs);
    }
    return false;
  }

  async newSession() {
    const s = new Session(await this.browser.newContext(CONTEXT_OPTIONS), this.url);
    try {
      const T = Date.now();
      if (!(await s.open())) { await s.close(); return null; }
      this.log(`Session prête (${fmtSecs(Date.now() - T)} s)`);
      return s;
    } catch (e) { await s.close(); throw e; }
  }

  async loop() {
    const { events } = this;
    if (!(await this.waitOpening())) return 'cancelled';
    const tStart = Date.now();
    this.setState('préparation', 'démarrage');
    this.browser = await chromium.launch();
    const request = (await this.browser.newContext(CONTEXT_OPTIONS)).request;
    if (!this.url && !(await this.findEvent(request))) return 'cancelled';

    let session = null, fastUntil = 0, saleAnnounced = false, idleAnnounced = false;
    let round = 0, errors = 0, lastStatus = '';
    try {
      while (!this.cancelled) {
        round++;
        const t0 = Date.now();
        try {
          if (!session) {
            this.setState('ouverture', 'attente de la mise en vente');
            if (!(session = await this.newSession())) {
              if (!this.waitAnnounced && Date.now() >= this.openAt + 5000) { events.info('⏳ Pas encore en vente, surveillance en cours.'); this.waitAnnounced = true; }
              await this.sleep(Date.now() < this.openAt ? 3000 : TIMING.fastMs);
              continue;
            }
          }
          const tr = Date.now();
          const zones = await session.zones(this.rules);
          const free = zones.reduce((n, z) => n + z.seats.filter(s => s.free && !this.skip(s.id)).length, 0);
          if (!zones.length || !free) {
            // Aucune place tout public : vente pas encore ouverte, ou tout est pris
            if (!saleAnnounced && !idleAnnounced && Date.now() >= this.openAt + 5000) { events.info('⏳ Pas de place en vente au public pour l\'instant, surveillance en cours.'); idleAnnounced = true; }
          } else if (!saleAnnounced) { events.info('🎫 En vente, recherche en cours.'); saleAnnounced = true; }
          if (free && !fastUntil) fastUntil = Math.max(Date.now(), this.openAt) + TIMING.fastWindowMs;
          const cands = candidates(zones, this.places, id => this.skip(id), this.rules);
          errors = 0;
          const status = `${free} libres, ${cands.length} groupes conformes`;
          if (status !== lastStatus) { lastStatus = status; this.log(`#${round} ${status} (lecture ${Date.now() - tr} ms)`); }
          if (!cands.length) {
            const fast = Date.now() < fastUntil;
            this.setState('recherche', `aucune place conforme, ${fast ? 'rythme rapide' : `nouvel essai toutes les ${TIMING.slowMs / 1000} s`}`);
            if (saleAnnounced && !idleAnnounced && !fast) { events.info('🔎 Rien de conforme pour l\'instant, surveillance en cours.'); idleAnnounced = true; }
            await this.sleep(fast ? TIMING.fastMs : TIMING.slowMs);
            continue;
          }
          const best = cands[0];
          const desc = `${best.zone.name} - rang ${best.seats[0].rang} places ${best.seats.map(s => s.num).join(', ')}`;
          this.setState('recherche', `tentative : ${desc}`);
          this.log('Tentative :', desc, `(${best.seats[0].rates.join(' / ')})`);
          if (this.dryRun) { this.log(`Dry-run : sélection non envoyée (essai en ${fmtSecs(Date.now() - t0)} s)`); return 'dry'; }
          const ts = Date.now();
          if (!(await session.select(best.zone, best.seats, this.rules.tarif, this.rules.tarifExclu))) {
            // Pris par un autre panier (invisible dans l'API) ou refusé : écartés le temps d'un panier, nouvelle session
            this.log(`Sélection refusée (${session.why}, ${fmtSecs(Date.now() - ts)} s) : recherche poursuivie`);
            best.seats.forEach(s => this.blocked.set(s.id, Date.now() + HOLD_MS));
            if (session.zoneMissing) best.all.forEach(s => this.blocked.set(s.id, Date.now() + HOLD_MS));
            await session.close(); session = null;
            continue;
          }
          const added = Date.now();
          this.log(`Sièges réservés (${fmtSecs(added - ts)} s), coordonnées…`);
          let pay;
          try { pay = await session.checkout(this.club.buyer()); }
          catch (e) {
            events.info(`⚠️ ${e.message.split('\n')[0]}. Recherche arrêtée : vérifie les coordonnées de l'acheteur (ACHETEUR_… dans .env).`);
            return 'failed';
          }
          this.log(`Page de paiement prête (${fmtSecs(Date.now() - added)} s après la réservation)`);
          idleAnnounced = false;
          this.setState('proposition', desc);
          const tarif = best.seats[0].tarif ? ` - ${best.seats[0].tarif}` : '';
          const decision = await events.proposal({
            desc: desc + tarif, timing: this.timing(t0, added, tStart), seats: best.seats, expiresAt: pay.expiresAt,
            link: pay.link, linkText: '💳 Payer', released: 'expiry',
            image: () => seatMapImage(this.browser, best.all, best.seats, desc, this.rules),
          });
          if (decision === 'keep') { this.setState('terminé', desc); return 'kept'; }
          if (decision === 'cancel') return 'cancelled';
          if (decision === 'refuse') best.seats.forEach(s => this.refused.add(s.id));
          // Commande suivante dans une nouvelle session ; celle-ci expire d'elle-même
          await session.close(); session = null;
          fastUntil = Date.now() + TIMING.fastWindowMs;
        } catch (e) {
          errors++;
          this.log(`#${round} erreur : ${e.message.split('\n')[0]}`);
          if (session) { await session.close(); session = null; }
          if (errors >= 5) {
            this.log('Erreurs répétées : redémarrage du navigateur');
            await this.browser.close().catch(() => {});
            this.browser = await chromium.launch();
            errors = 0;
          }
          await this.sleep(1000);
        }
      }
    } finally { if (session) await session.close(); }
    return 'cancelled';
  }
}

module.exports = { Hunt, candidates };
