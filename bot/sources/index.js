// Sources de billetterie, par type de site. Chaque source fournit :
//   Hunt                       moteur de recherche (contrat dans lib/engine.js)
//   onSale(club, page)         matchs en vente : [{ label, date, team?, url? }]
//   calendar(club, page, dir)  matchs à venir et ouverture de leur billetterie : { items, warning }
//   ownsUrl(url), nameFromUrl(url)  liens de match acceptés par /match
//   missingSettings(club)      réglages manquants dans .env pour réserver (noms des variables)
//   upcoming(club, request)    facultatif : matchs et ouverture de leur vente, par simple requête (veille des ventes)
module.exports = {
  seetickets: require('./seetickets'),
  billetweb: require('./billetweb'),
  weezevent: require('./weezevent'),
};
