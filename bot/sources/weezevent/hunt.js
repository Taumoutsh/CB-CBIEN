// Moteur Weezevent (Ducs d'Angers) : attend l'ouverture de la vente, lit les sièges des zones voulues, réserve le
// meilleur groupe conforme et propose la page de paiement de la commande (Garder / Refuser).
//
// Comme Billetweb, le bot remplit les coordonnées de l'acheteur et le téléphone reprend la commande par sa page de
// paiement. Deux méthodes, comme pour le basket :
//   - par requêtes (direct.js), la plus rapide : quelques envois, sans charger la page ni son plan 3D ;
//   - par navigateur (shop.js), en secours : la sélection se fait dans le plan 3D du site (quelques secondes par siège).
//     Elle prend le relais pendant FALLBACK_MS dès que le site répond autrement que prévu à la méthode par requêtes.
// L'API du plan montre encore « disponibles » les sièges réservés par d'autres paniers : un refus du site au moment de
// la réservation écarte ces sièges pendant la durée d'un panier.
const { chromium, CONTEXT_OPTIONS } = require('../../lib/browser');
const { BaseHunt, TIMING, fmtSecs } = require('../../lib/engine');
const { norm, sameDate, teamMatches } = require('../../lib/dates');
const { geometry, inZone, rowGroups, predilection, byPredilection, seatMapImage } = require('../../lib/seats');
const { listEvents, venueOf, Session } = require('./shop');
const { Direct, Gate, Unexpected } = require('./direct');
const { venueImage } = require('../../lib/venue');

const HOLD_MS = 10 * 60000;      // durée d'un panier : sièges refusés par le site écartés pendant ce temps
const FALLBACK_MS = 10 * 60000;  // méthode par navigateur après un échec de la méthode par requêtes, avant un nouvel essai
const IDLE_MS = 4 * 60000;       // session par requêtes renouvelée au-delà, tant qu'aucune place n'est tentée
const REQUESTS = (process.env.ANGERS_METHODE_REQUETES || '1') !== '0';

// Zones « vers le milieu de la glace » (rules.milieuGlace, places centrales) : rangée du bord de la glace avant celle
// de derrière ; dans chaque rangée, le bloc face au centre de la glace (N, VC) avec sa zone de prédilection centrée,
// puis les blocs voisins (M et O, VL et WC) avec leur zone de prédilection décalée du côté du milieu de la glace et,
// dedans, le groupe le plus proche de la ligne médiane d'abord.
const RING = 0.15;  // écart de distance à la glace au-delà duquel un bloc est dans la rangée de derrière

// Bloc voisin du centre : zone de prédilection de la même hauteur que d'habitude, collée au bord du bloc côté milieu de
// la glace. rank : 0 dedans, 1 bonne largeur mais rang trop haut ou trop bas, 2 trop loin du milieu ; mid : écart au
// milieu de la glace (plus petit d'abord) ; dy : écart en hauteur à la zone de prédilection.
function sidePredilection(geo, rules, grp, inner) {
  const p = rules.predilection, w = (geo.maxX - geo.minX) || 1;
  const gx = grp.reduce((t, s) => t + s.x, 0) / grp.length;
  const f = inner < 0 ? (gx - geo.minX) / w : (geo.maxX - gx) / w;  // 0 = bord côté milieu de la glace, 1 = bord opposé
  const h = geo.height(grp[0].y), hc = rules.hauteur / 2;
  const dx = Math.max(0, f - p), dy = Math.max(0, Math.abs(h - hc) - (p * rules.hauteur) / 2) / rules.hauteur;
  return { rank: dx < 1e-9 && dy < 1e-9 ? 0 : dx < 1e-9 ? 1 : 2, dy, mid: grp.reduce((t, s) => t + (s.mid ?? 1), 0) / grp.length, rnd: Math.random() };
}
const bySide = (a, b) => a.rank - b.rank || (a.rank === 1 ? a.dy - b.dy : 0) || a.mid - b.mid || a.rnd - b.rnd;

// Groupes conformes de toutes les zones, du meilleur au moins bon : zone préférée (ordre de rules.zones), puis
// catégorie (1, la plus chère, puis 2, puis 3 : les virages de catégorie 2 avant ceux de catégorie 3), puis :
//   - places centrales (rules.milieuGlace) : rangée, bloc face au centre puis blocs voisins côté milieu de la glace ;
//   - autres zones : la zone de prédilection de la zone (au hasard dedans, puis l'axe central, puis les côtés).
// Pas de siège isolé laissé libre.
function candidates(zones, places, skip, rules) {
  const tier = z => rules.zones.findIndex(k => norm(z.name).includes(norm(k)));
  const central = z => (rules.milieuGlace || []).some(k => norm(z.name).includes(norm(k))) && z.mid !== undefined && z.depth !== undefined;
  const near = Math.min(...zones.filter(x => central(x.zone)).map(x => x.zone.depth), Infinity);
  const out = [];
  for (const { zone, seats } of zones) {
    if (!seats.length) continue;
    const geo = geometry(seats, { courtBottom: true }), ok = inZone(geo, rules);
    const mid = central(zone);
    // Bloc voisin : côté du milieu de la glace d'après la position de ses sièges extrêmes (-1 : petits x, 1 : grands x)
    let inner = 0;
    if (mid && zone.mid > 0) {
      const lo = seats.reduce((m, s) => (s.x < m.x ? s : m)), hi = seats.reduce((m, s) => (s.x > m.x ? s : m));
      inner = (lo.mid ?? 1) <= (hi.mid ?? 1) ? -1 : 1;
    }
    for (const grp of rowGroups(seats, places, s => s.free && !skip(s.id) && ok(s), { gap: geo.unit * 1.6 })) {
      const base = { zone, seats: grp, all: seats, tier: tier(zone), cat: Math.max(...grp.map(s => s.catNo || 99)) };
      if (!mid) out.push({ ...base, ring: 0, side: 0, ...predilection(geo, rules, grp) });
      else out.push({ ...base, ring: zone.depth - near > RING ? 1 : 0, side: inner ? 1 : 0, inner, ...(inner ? sidePredilection(geo, rules, grp, inner) : predilection(geo, rules, grp)) });
    }
  }
  return out.sort((a, b) => a.tier - b.tier || a.cat - b.cat || a.ring - b.ring || a.side - b.side || (a.side ? bySide(a, b) : byPredilection(a, b)));
}

class Hunt extends BaseHunt {
  constructor(o) {
    super(o);
    this.blocked = new Map();  // sièges refusés par le site → heure de fin d'écart
    // Pas de reprise des paniers expirés : Weezevent garde les places bien après le compte à rebours et n'offre aucun
    // moyen de le prolonger (essais : même session, « Annuler le paiement », nouvelle session). Recherche normale à
    // l'expiration ; les mêmes places peuvent revenir quand le site les libère.
    this.renewMax = 0;
    this.gate = null;       // entrée de la billetterie (méthode par requêtes) : garde la place dans la file d'attente
    this.browserUntil = 0;  // méthode par navigateur jusqu'à cette heure
  }

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
      if (!this.waitAnnounced && Date.now() >= this.openAt) { this.log('⏳ Pas encore en vente, surveillance en cours.'); this.waitAnnounced = true; }
      await this.sleep(this.pollDelay());
    }
    return false;
  }

  // Méthode par requêtes pour la prochaine session ? (réglage, n° du match connu, pas de repli en cours)
  direct() {
    const id = (String(this.url).match(/id_evenement=(\d+)/) || [])[1];
    if (!REQUESTS || !id || Date.now() < this.browserUntil) return false;
    if (!this.gate) this.gate = new Gate(id);
    return true;
  }

  // Réponse non reconnue par la méthode par requêtes : méthode par navigateur pendant FALLBACK_MS
  toBrowser(e) {
    this.browserUntil = Date.now() + FALLBACK_MS;
    this.log(`Méthode par requêtes : ${e.message.split('\n')[0]} → méthode par navigateur pendant ${FALLBACK_MS / 60000} min`);
  }

  // Session d'achat ouverte, ou null tant que la vente n'est pas ouverte
  async newSession() {
    const direct = this.direct();
    const ctx = await this.browser.newContext(CONTEXT_OPTIONS);
    const s = direct ? new Direct(ctx, this.gate) : new Session(ctx, this.url);
    try {
      const T = Date.now();
      if (!(await s.open())) { await s.close(); return null; }
      this.log(`Session prête (${direct ? 'requêtes' : 'navigateur'}, ${fmtSecs(Date.now() - T)} s)`);
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

    let session = null, fastUntil = 0, saleAnnounced = false, idleAnnounced = false, queueAnnounced = false;
    let round = 0, errors = 0, lastStatus = '';
    try {
      while (!this.cancelled) {
        round++;
        const t0 = Date.now();
        try {
          if (!session) {
            this.setState('ouverture', 'attente de la mise en vente');
            if (!(session = await this.newSession())) {
              // File d'attente du site (forte affluence) : le tour est attendu, la place dans la file est gardée
              const queued = this.gate && this.gate.queued && Date.now() >= this.browserUntil;
              if (queued) this.setState('ouverture', `file d'attente du site, position ${this.gate.rank}`);
              if (queued && !queueAnnounced) { this.log('⏳ File d\'attente du site : attente du tour.'); queueAnnounced = true; }
              else if (!queued && !this.waitAnnounced && Date.now() >= this.openAt + 5000) { this.log('⏳ Pas encore en vente, surveillance en cours.'); this.waitAnnounced = true; }
              await this.sleep(queued ? Math.min(this.pollDelay(), 1000) : this.pollDelay());
              continue;
            }
          }
          const tr = Date.now();
          const zones = await session.zones(this.rules);
          const free = zones.reduce((n, z) => n + z.seats.filter(s => s.free && !this.skip(s.id)).length, 0);
          if (!zones.length || !free) {
            // Aucune place tout public : vente pas encore ouverte, ou tout est pris
            if (!saleAnnounced && !idleAnnounced && Date.now() >= this.openAt + 5000) { this.log('⏳ Pas de place en vente au public pour l\'instant, surveillance en cours.'); idleAnnounced = true; }
          } else if (!saleAnnounced) { this.log('🎫 En vente, recherche en cours.'); saleAnnounced = true; }
          if (free && !fastUntil) fastUntil = Math.max(Date.now(), this.openAt) + TIMING.fastWindowMs;
          const cands = candidates(zones, this.places, id => this.skip(id), this.rules);
          errors = 0;
          const status = `${free} libres, ${cands.length} groupes conformes`;
          if (status !== lastStatus) { lastStatus = status; this.log(`#${round} ${status} (lecture ${Date.now() - tr} ms)`); }
          // Panier expiré sans réponse : les mêmes places d'abord (l'API les montre libres même encore réservées : le
          // refus du site au moment de « SUITE » fait réessayer jusqu'à leur libération)
          let rg = null;
          if (this.renew) {
            const flat = zones.flatMap(z => z.seats.map(s => Object.assign(s, { zoneRef: z })));
            const g = this.renewGroup(flat);
            if (g) rg = { zone: g[0].zoneRef.zone, seats: g, all: g[0].zoneRef.seats, renewal: this.renew.n };
            else if (this.renewing()) { this.setState('recherche', 'reprise des places expirées'); await this.sleep(TIMING.fastMs); continue; }
          }
          if (!rg && !cands.length) {
            const fast = Date.now() < fastUntil;
            this.setState('recherche', `aucune place conforme, ${fast ? 'rythme rapide' : `nouvel essai toutes les ${TIMING.slowMs / 1000} s`}`);
            if (saleAnnounced && !idleAnnounced && !fast) { this.log('🔎 Rien de conforme pour l\'instant, surveillance en cours.'); idleAnnounced = true; }
            // Session par requêtes renouvelée pendant la veille : elle reste valable le jour où une place se libère
            if (session.openedAt && Date.now() - session.openedAt > IDLE_MS) { await session.close(); session = null; }
            await this.sleep(fast ? TIMING.fastMs : TIMING.slowMs);
            continue;
          }
          const best = rg || cands[0];
          const desc = `${best.zone.name} - rang ${best.seats[0].rang} places ${best.seats.map(s => s.num).join(', ')}`;
          this.setState('recherche', `tentative : ${desc}`);
          this.log('Tentative :', desc, `(${best.seats[0].rates.map(r => r.name).join(' / ')})`);
          if (this.dryRun) { this.log(`Dry-run : sélection non envoyée (essai en ${fmtSecs(Date.now() - t0)} s)`); return 'dry'; }
          const ts = Date.now();
          if (!(await session.select(best.zone, best.seats, this.rules.tarif, this.rules.tarifExclu))) {
            // Pris par un autre panier (invisible dans l'API) ou refusé : écartés le temps d'un panier ; nouvelle session,
            // sauf par requêtes où la même session sert aux essais suivants
            this.log(`Sélection refusée (${session.why}, ${fmtSecs(Date.now() - ts)} s) : recherche poursuivie`);
            if (!rg) best.seats.forEach(s => this.blocked.set(s.id, Date.now() + HOLD_MS));
            if (session.zoneMissing) best.all.forEach(s => this.blocked.set(s.id, Date.now() + HOLD_MS));
            if (!session.reusable) { await session.close(); session = null; }
            continue;
          }
          const added = Date.now();
          this.log(`Sièges réservés (${fmtSecs(added - ts)} s), coordonnées…`);
          let pay;
          try { pay = await session.checkout(this.club.buyer()); }
          catch (e) {
            // Réponse non reconnue par la méthode par requêtes : ces sièges restent réservés par cette session perdue,
            // ils sont écartés le temps d'un panier et la recherche continue par navigateur
            if (e instanceof Unexpected) { best.seats.forEach(s => this.blocked.set(s.id, Date.now() + HOLD_MS)); throw e; }
            events.info(`⚠️ ${e.message.split('\n')[0]}. Recherche arrêtée : vérifie les coordonnées de l'acheteur (ACHETEUR_… dans .env).`);
            return 'failed';
          }
          this.log(`Page de paiement prête (${fmtSecs(Date.now() - added)} s après la réservation)`);
          idleAnnounced = false;
          this.setState('proposition', desc);
          this.renew = null;
          const tarif = (best.seats[0].tarif ? ` - ${best.seats[0].tarif}` : '') + (pay.total ? ` - ${pay.total}` : '');
          const root = session.root;
          const decision = await events.proposal({
            desc: desc + tarif, timing: this.timing(t0, added, tStart), seats: best.seats, expiresAt: pay.expiresAt,
            renewal: best.renewal || 0, renewNext: this.renewNext(best.seats), renewMax: this.renewMax,
            link: pay.link, linkText: '💳 Payer', released: 'expiry',
            image: () => seatMapImage(this.browser, best.all, best.seats, desc, this.rules, { courtBottom: true, inner: best.inner }),  // glace en bas
            // Toute la patinoire : zones, glace, place proposée (position approximative dans sa zone)
            venue: () => venueImage(this.browser, venueOf(root, best.zone.uuid, best.all, best.seats, `${this.matchLabel || 'Angers IceParc'} : ${desc}`)),
          });
          if (decision === 'keep') { this.setState('terminé', desc); return 'kept'; }
          if (decision === 'cancel') return 'cancelled';
          if (decision === 'refuse') best.seats.forEach(s => this.refused.add(s.id));
          if (decision === 'expired') this.expired(best.seats);
          // Commande suivante dans une nouvelle session ; celle-ci expire d'elle-même
          await session.close(); session = null;
          fastUntil = Date.now() + TIMING.fastWindowMs;
        } catch (e) {
          errors++;
          // Méthode par requêtes : réponse non reconnue, ou erreurs répétées → méthode par navigateur un moment
          const direct = REQUESTS && Date.now() >= this.browserUntil && (session ? session instanceof Direct : !!this.gate);
          if (direct && (e instanceof Unexpected || errors >= 3)) this.toBrowser(e);
          else this.log(`#${round} erreur : ${e.message.split('\n')[0]}`);
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
