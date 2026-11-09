// Moteur Billetweb (Cholet Hockey) : attend l'ouverture de la vente, lit les sièges pris, réserve le meilleur groupe
// conforme et propose le lien de paiement de la commande (Garder / Refuser).
//
// Différences avec Seetickets : les sièges sont réservés pour une commande dont les coordonnées de l'acheteur sont
// remplies par le bot (le site y envoie les billets), et le téléphone reprend la commande par son lien de paiement.
// Une commande refusée ou abandonnée ne peut pas être annulée : ses sièges sont libérés à l'expiration du panier.
const { chromium, CONTEXT_OPTIONS } = require('../../lib/browser');
const { BaseHunt, TIMING, fmtSecs, euros } = require('../../lib/engine');
const { norm, sameDate, teamMatches } = require('../../lib/dates');
const { geometry, inZone, rowGroups, predilection, byPredilection, seatMapImage } = require('../../lib/seats');
const { listEvents, onSale, Session } = require('./shop');

// Tribune d'un siège dans l'ordre de préférence (morceau du nom : « MILLET ») ; undefined si hors des tribunes voulues
const tierOf = rules => s => { const i = rules.tribunes.findIndex(k => norm(s.cat).includes(norm(k))); return i < 0 ? undefined : i; };

// Sièges de la tribune principale : blocs dont le nom contient une des tribunes voulues (rangs PMR à part).
// free : siège en vente au public (catégorie d'une tribune voulue) et pas encore pris.
function stand(seats, taken, rules) {
  const wanted = s => rules.tribunes.some(k => norm(s.section).includes(norm(k))) && !/pmr/i.test(s.section);
  const tier = tierOf(rules);
  return seats.filter(wanted).map(s => ({ ...s, free: tier(s) !== undefined && !/pmr/i.test(s.cat) && !taken.has(s.id) }));
}

// Groupes de `places` sièges voisins conformes aux règles, du meilleur au moins bon (zone de prédilection,
// lib/seats.js) : dedans au hasard, puis dans l'axe central de la tribune, puis sur les côtés, du plus proche au plus
// éloigné. Comme le site, aucun groupe ne laisse un siège libre isolé à côté de lui.
function candidates(seats, places, refused, rules) {
  if (!seats.length) return [];
  const geo = geometry(seats), zone = inZone(geo, rules), tier = tierOf(rules);
  const groups = rowGroups(seats, places, s => s.free && !refused.has(s.id) && zone(s), { gap: geo.unit * 1.6, same: (a, b) => tier(a) === tier(b) });
  return groups.map(grp => ({ seats: grp, ...predilection(geo, rules, grp) })).sort(byPredilection);
}

class Hunt extends BaseHunt {
  constructor(o) {
    super(o);
    // Billetweb garde une commande en attente de paiement ≈ 20 min, le double du compte à rebours affiché (10 min) :
    // ses places ne sont libérées qu'≈ 10 min après l'expiration (mesuré)
    this.renewWaitMs = 12 * 60000;
  }

  async run() {
    try { return await this.loop(); } finally { if (this.browser) await this.browser.close().catch(() => {}); }
  }

  // Le match sur la page de la billetterie : par sa date, sinon par le nom de l'adversaire
  async findEvent(scan) {
    this.setState('ouverture', `recherche du match ${this.target} sur la billetterie`);
    while (!this.cancelled) {
      try {
        const events = await listEvents(scan, this.club.list);
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

  async newSession() {
    const s = new Session(await this.browser.newContext(CONTEXT_OPTIONS), this.url);
    try {
      const T = Date.now();
      if (!(await s.start(this.rules.tarif, this.places))) { await s.close(); return null; }
      this.log(`Session prête : ${s.tarif.name} ${euros(s.tarif.cents)}, plan de ${s.seats.length} sièges (${fmtSecs(Date.now() - T)} s)`);
      return s;
    } catch (e) { await s.close(); throw e; }
  }

  async loop() {
    const { events } = this;
    if (!(await this.waitOpening())) return 'cancelled';
    const tStart = Date.now();
    this.setState('préparation', 'démarrage');
    this.browser = await chromium.launch();
    let scan = await (await this.browser.newContext(CONTEXT_OPTIONS)).newPage();
    if (!this.url && !(await this.findEvent(scan))) return 'cancelled';

    let session = null, fastUntil = 0, saleAnnounced = false, idleAnnounced = false;
    let round = 0, errors = 0, lastStatus = '';
    try {
      while (!this.cancelled) {
        round++;
        const t0 = Date.now();
        try {
          // Session d'achat : ouverte dès que le tarif est en vente (vérifié d'abord par une simple requête)
          if (session && session.places !== this.places) { await session.close(); session = null; }  // /places modifié
          if (!session) {
            this.setState('ouverture', 'attente de la mise en vente');
            if (!(await onSale(scan, this.url, this.rules.tarif, this.places)) || !(session = await this.newSession())) {
              if (!this.waitAnnounced && Date.now() >= this.openAt + 5000) { this.log('⏳ Pas encore en vente, surveillance en cours.'); this.waitAnnounced = true; }
              await this.sleep(this.pollDelay());
              continue;
            }
            if (!saleAnnounced) { this.log('🎫 En vente, recherche en cours.'); saleAnnounced = true; }
            if (!fastUntil) fastUntil = Math.max(Date.now(), this.openAt) + TIMING.fastWindowMs;
          }
          const tr = Date.now();
          const seats = stand(session.seats, await session.taken(), this.rules);
          const cands = candidates(seats, this.places, this.refused, this.rules);
          errors = 0;
          const status = `${seats.filter(s => s.free).length} libres, ${cands.length} groupes conformes`;
          if (status !== lastStatus) { lastStatus = status; this.log(`#${round} ${status} (lecture ${Date.now() - tr} ms)`); }
          // Panier expiré sans réponse : les mêmes places d'abord, dès que le site les libère
          const rg = this.renew ? this.renewGroup(seats) : null;
          if (this.renew && !rg && this.renewing()) { this.setState('recherche', 'reprise des places expirées'); await this.sleep(TIMING.fastMs); continue; }
          if (!rg && !cands.length) {
            const fast = Date.now() < fastUntil;
            this.setState('recherche', `aucune place conforme, ${fast ? 'rythme rapide' : `nouvel essai toutes les ${TIMING.slowMs / 1000} s`}`);
            if (!idleAnnounced && !fast) { this.log('🔎 Rien de conforme pour l\'instant, surveillance en cours.'); idleAnnounced = true; }
            await this.sleep(fast ? TIMING.fastMs : TIMING.slowMs);
            continue;
          }
          const best = rg ? { seats: rg, renewal: this.renew.n } : cands[0], first = best.seats[0];
          const price = session.tarif.cents ? ` - ${euros(session.tarif.cents * this.places)}` : '';
          const desc = `${first.section} - ${session.tarif.name} - rang ${first.rang} places ${best.seats.map(s => s.num).join(', ')}`;
          this.setState('recherche', `tentative : ${desc}`);
          this.log('Tentative :', desc);
          if (this.dryRun) { this.log(`Dry-run : sélection non envoyée (essai en ${fmtSecs(Date.now() - t0)} s)`); return 'dry'; }
          // Session ouverte depuis plus de 2 min : son compte à rebours est déjà entamé, une neuve le redonne en entier
          if (Date.now() - session.startedAt > 2 * 60000) {
            await session.close();
            if (!(session = await this.newSession())) continue;
          }
          const ts = Date.now();
          if (!(await session.select(best.seats))) {
            // Pris entre-temps : nouvelle session (la sélection en attente de celle-ci est abandonnée)
            this.log(`Sélection refusée (${fmtSecs(Date.now() - ts)} s) : recherche poursuivie`);
            await session.close(); session = null;
            continue;
          }
          const added = Date.now();
          this.log(`Sièges réservés (${fmtSecs(added - ts)} s), coordonnées…`);
          let pay;
          try { pay = await session.checkout(this.club.buyer()); }
          catch (e) {
            // Coordonnées refusées : erreur de réglage, pas de nouvel essai automatique
            events.info(`⚠️ ${e.message.split('\n')[0]}. Recherche arrêtée : vérifie les coordonnées de l'acheteur (ACHETEUR_… dans .env).`);
            return 'failed';
          }
          this.log(`Lien de paiement prêt (${fmtSecs(Date.now() - added)} s après la réservation)`);
          idleAnnounced = false;
          this.setState('proposition', desc);
          this.renew = null;
          const decision = await events.proposal({
            desc: desc + price, timing: this.timing(t0, added, tStart), seats: best.seats, expiresAt: pay.expiresAt,
            renewal: best.renewal || 0, renewNext: this.renewNext(best.seats), renewMax: this.renewMax,
            link: pay.link, linkText: '💳 Payer', released: 'expiry',
            image: () => seatMapImage(this.browser, seats, best.seats, desc, this.rules),
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
          this.log(`#${round} erreur : ${e.message.split('\n')[0]}`);
          if (session) { await session.close(); session = null; }
          if (errors >= 5) {
            this.log('Erreurs répétées : redémarrage du navigateur');
            await this.browser.close().catch(() => {});
            this.browser = await chromium.launch();
            scan = await (await this.browser.newContext(CONTEXT_OPTIONS)).newPage();
            errors = 0;
          }
          await this.sleep(1000);
        }
      }
    } finally { if (session) await session.close(); }
    return 'cancelled';
  }
}

module.exports = { Hunt, candidates, stand };
