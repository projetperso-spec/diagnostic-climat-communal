/* Diagnostic de vulnérabilité climatique communal.
   Tout se passe dans le navigateur : la page interroge les services publics au moment
   de la demande et lit les fichiers par département préparés par les scripts R. */
(function () {
  "use strict";

  // ---------- Réglages ----------
  const GEO = "https://geo.api.gouv.fr";
  const STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search";
  const JETON = "https://planetarycomputer.microsoft.com/api/sas/v1/token/landsat-c2-l2";
  const GEORISQUES = "https://georisques.gouv.fr/api/v1";
  const NB_SCENES = 5;            // images d'été superposées (médiane par pixel)
  const NUAGES_MAX = 20;          // % de nuages sur l'image entière
  const PART_VALIDE_MIN = 0.9;    // part de la commune sans nuage pour garder une image
  const PART_REPLI = 0.5;         // seuil de repli quand moins de deux images sont dégagées
  const RAYON_SITE_M = 100;       // voisinage d'un lieu sensible
  const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
  const FRAIS_MIN_HA = 0.5;       // surface minimale d'un lieu de fraîcheur (parc, jardin public, bois)
  const PROCHE_FRAIS_M = 300;     // proximité d'un lieu de fraîcheur (cinq minutes à pied environ)
  const MARGE_FRAIS_M = 400;      // les lieux situés juste au-delà de la limite communale comptent aussi
  const ECART_FRAIS = -1;         // °C sous la médiane pour parler de fraîcheur mesurée
  const EMPRISE_MAX_KM2 = 900;    // au-delà, pas de requête OpenStreetMap en direct
  const TYPES = {
    ecole: { nom: "École", pluriel: "écoles (maternelles, élémentaires, primaires)", lettre: "É" },
    creche: { nom: "Crèche", pluriel: "crèches et autres accueils du jeune enfant", lettre: "C" },
    ehpad: { nom: "Hébergement personnes âgées", pluriel: "hébergements pour personnes âgées (EHPAD, résidences autonomie)", lettre: "A" },
  };
  // Écart de température : bleu <-> gris neutre <-> rouge. Végétation et priorité : une seule teinte.
  const RAMPE_ECART = ["#104281", "#256abf", "#6da7ec", "#b7d3f6", "#f0efec", "#f3c0b6", "#e5806f", "#cf3f38", "#8f1d1d"];
  const RAMPE_NDVI = ["#f1f4e8", "#cfe3b4", "#9ccb7b", "#5fa94a", "#2c8327", "#0b5c12"];
  const CLASSES_SCORE = ["#e9e3f8", "#c4b8ee", "#9a88dd", "#6a55bf", "#3d2c8d"];

  proj4.defs("EPSG:3035", "+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +units=m +no_defs");
  proj4.defs("EPSG:5490", "+proj=utm +zone=20 +ellps=GRS80 +units=m +no_defs");
  proj4.defs("EPSG:2975", "+proj=utm +zone=40 +south +ellps=GRS80 +units=m +no_defs");

  const $ = (s) => document.querySelector(s);
  const fmt = (v, d = 0) => (v == null || !isFinite(v)) ? "n. d." : v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const signe = (v, d = 1) => (v == null || !isFinite(v)) ? "n. d." : (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v), d);
  const echappe = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  async function json(url, options) {
    const r = await fetch(url, options);
    if (!r.ok) throw new Error(url.split("?")[0] + " a répondu " + r.status);
    return r.json();
  }

  // ---------- Petits outils numériques ----------
  function quantile(triees, q) {
    if (!triees.length) return NaN;
    const p = (triees.length - 1) * q, b = Math.floor(p);
    return triees[b] + (triees[Math.min(b + 1, triees.length - 1)] - triees[b]) * (p - b);
  }
  function mediane(v) { const t = Float64Array.from(v).sort(); return quantile(t, 0.5); }
  // Rang centile (0 à 1) de chaque valeur dans sa série ; NaN reste NaN.
  function rangs(valeurs) {
    const ok = valeurs.filter((v) => isFinite(v)).sort((a, b) => a - b);
    return valeurs.map((v) => {
      if (!isFinite(v)) return NaN;
      let lo = 0, hi = ok.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (ok[m] < v) lo = m + 1; else hi = m; }
      let hi2 = lo; while (hi2 < ok.length && ok[hi2] === v) hi2++;
      return ((lo + hi2) / 2) / ok.length;
    });
  }
  function dansAnneau(x, y, a) {
    let dedans = false;
    for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
      const xi = a[i][0], yi = a[i][1], xj = a[j][0], yj = a[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dedans = !dedans;
    }
    return dedans;
  }
  function polygones(geom) { return geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates; }
  function dansGeometrie(x, y, geom) {
    for (const poly of polygones(geom)) {
      if (!dansAnneau(x, y, poly[0])) continue;
      let trou = false;
      for (let k = 1; k < poly.length; k++) if (dansAnneau(x, y, poly[k])) { trou = true; break; }
      if (!trou) return true;
    }
    return false;
  }
  function couleurRampe(rampe, t) {
    t = Math.max(0, Math.min(1, t)) * (rampe.length - 1);
    const i = Math.min(rampe.length - 2, Math.floor(t)), f = t - i;
    const a = rampe[i], b = rampe[i + 1];
    return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f));
  }
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const R_ECART = RAMPE_ECART.map(hex), R_NDVI = RAMPE_NDVI.map(hex);

  // ---------- Suivi des étapes ----------
  const etapes = new Map();
  function etape(cle, texte, classe) {
    etapes.set(cle, { texte, classe: classe || "" });
    $("#etat").innerHTML = "<ul>" + [...etapes.values()].map((e) => `<li class="${e.classe}">${echappe(e.texte)}</li>`).join("") + "</ul>";
  }

  // ---------- Recherche de commune ----------
  const champ = $("#champ"), liste = $("#propositions");
  let minuterie = null, propositions = [], actif = -1;
  // Groupements de communes (intercommunalités, territoires du Grand Paris), préparés par R/04.
  const pTerritoires = fetch("data/territoires.json").then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const sansAccent = (t) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  function montrerPropositions() {
    liste.hidden = !propositions.length;
    liste.innerHTML = propositions.map((c, i) =>
      `<li role="option" data-i="${i}" aria-selected="${i === actif}"><span>${echappe(c.nom)}</span><small>${c.communes ? "groupement de " + c.communes.length + " communes" : echappe((c.codesPostaux || [])[0] || c.code)} · ${fmt(c.population)} hab.</small></li>`).join("");
  }
  const cleDe = (c) => (c.communes ? "g" : "") + c.code;
  champ.addEventListener("input", () => {
    clearTimeout(minuterie);
    const q = champ.value.trim();
    if (q.length < 2) { propositions = []; montrerPropositions(); return; }
    minuterie = setTimeout(async () => {
      const param = /^\d{5}$/.test(q) ? "codePostal=" + q : "nom=" + encodeURIComponent(q);
      let communes = [];
      try {
        communes = await json(`${GEO}/communes?${param}&fields=nom,code,codesPostaux,population&boost=population&limit=6`);
      } catch (e) { communes = []; }
      const cherche = sansAccent(q);
      const groupes = (await pTerritoires).filter((t) => sansAccent(t.nom).includes(cherche)).slice(0, 3);
      if (champ.value.trim() !== q) return;
      propositions = communes.concat(groupes);
      actif = propositions.length ? 0 : -1;
      montrerPropositions();
    }, 220);
  });
  champ.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!propositions.length) return;
      actif = (actif + (e.key === "ArrowDown" ? 1 : -1) + propositions.length) % propositions.length;
      montrerPropositions(); e.preventDefault();
    } else if (e.key === "Escape") { propositions = []; montrerPropositions(); }
  });
  $("#recherche").addEventListener("submit", (e) => {
    e.preventDefault();
    if (propositions[actif]) choisir(cleDe(propositions[actif]));
  });
  liste.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li");
    if (li) choisir(cleDe(propositions[+li.dataset.i]));
  });
  function choisir(code) {
    propositions = []; montrerPropositions();
    if (location.hash === "#" + code) lancer(code); else location.hash = code;
  }
  window.addEventListener("hashchange", depuisAdresse);
  function depuisAdresse() {
    const code = location.hash.replace("#", "");
    if (/^([0-9][0-9AB][0-9]{3}|g[0-9]{9})$/.test(code)) lancer(code);
  }

  // ---------- Carte ----------
  let carte = null, couches = {};
  function preparerCarte() {
    if (carte) return;
    carte = L.map("carte", { zoomSnap: 0.25 });
    L.tileLayer("https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}",
      { attribution: "Fond : IGN, Plan IGN", maxZoom: 19 }).addTo(carte);
    L.control.scale({ imperial: false }).addTo(carte);
    carte.createPane("analyse").style.zIndex = 350;
    carte.createPane("carreaux").style.zIndex = 420;
    carte.createPane("contour").style.zIndex = 440;
  }
  function viderCarte() {
    for (const c of Object.values(couches)) if (c) carte.removeLayer(c);
    couches = {};
  }
  function majAffichage() {
    if (!carte) return;
    const fond = document.querySelector('input[name="fond"]:checked').value;
    const opacite = +$("#opacite").value / 100;
    for (const cle of ["lst", "ndvi"]) {
      const c = couches[cle];
      if (!c) continue;
      if (fond === cle) { c.addTo(carte); c.setOpacity(opacite); } else carte.removeLayer(c);
    }
    if (couches.carreaux) { if ($("#voir-carreaux").checked) couches.carreaux.addTo(carte); else carte.removeLayer(couches.carreaux); }
    if (couches.sites) { if ($("#voir-sites").checked) couches.sites.addTo(carte); else carte.removeLayer(couches.sites); }
    if (couches.frais) { if ($("#voir-frais").checked) couches.frais.addTo(carte); else carte.removeLayer(couches.frais); }
    majLegende(fond);
  }
  for (const s of ['input[name="fond"]', "#voir-carreaux", "#voir-sites", "#voir-frais", "#opacite"]) {
    document.querySelectorAll(s).forEach((el) => el.addEventListener("input", majAffichage));
  }

  let courant = null;   // résultat du diagnostic en cours
  function majLegende(fond) {
    const d = courant, blocs = [];
    if (d && d.chaleur && fond === "lst") {
      blocs.push(`<div class="bloc"><div class="titre">Écart à la température de surface médiane</div>
        <div class="rampe" style="background:linear-gradient(90deg,${RAMPE_ECART.join(",")})"></div>
        <div class="bornes"><span>−${fmt(d.chaleur.borne)} °C</span><span>médiane (${fmt(d.chaleur.mediane, 1)} °C)</span><span>+${fmt(d.chaleur.borne)} °C</span></div></div>`);
    }
    if (d && d.chaleur && fond === "ndvi") {
      blocs.push(`<div class="bloc"><div class="titre">Indice de végétation (NDVI)</div>
        <div class="rampe" style="background:linear-gradient(90deg,${RAMPE_NDVI.join(",")})"></div>
        <div class="bornes"><span>0 (minéral, eau)</span><span>0,8 (végétation dense)</span></div></div>`);
    }
    if (d && d.carreaux && $("#voir-carreaux").checked) {
      blocs.push(`<div class="bloc"><div class="titre">Priorité des carreaux habités (rang dans le territoire étudié)</div>
        <div class="classes">${CLASSES_SCORE.map((c) => `<span style="background:${c}"></span>`).join("")}</div>
        <div class="bornes"><span>faible</span><span>forte</span></div></div>`);
    }
    if (d && d.sites && $("#voir-sites").checked) {
      blocs.push(`<div class="bloc"><div class="titre">Lieux sensibles</div><div class="puces">
        ${Object.entries(TYPES).map(([k, t]) => `<span><span class="puce ${k}">${t.lettre}</span> ${t.nom}</span>`).join("")}
        <span><span class="puce chaud">!</span> dans le cinquième le plus chaud</span></div></div>`);
    }
    if (d && d.frais && $("#voir-frais").checked) {
      blocs.push(`<div class="bloc"><div class="titre">Lieux de fraîcheur (parcs, jardins publics, bois d'au moins ${fmt(FRAIS_MIN_HA, 1)} ha)</div><div class="puces">
        <span><span class="aplat" style="background:rgba(27,175,122,.5)"></span> plus frais que la médiane d'au moins ${fmt(-ECART_FRAIS)} °C</span>
        <span><span class="aplat" style="background:rgba(27,175,122,.18)"></span> autres</span></div></div>`);
    }
    $("#legende").innerHTML = blocs.join("");
  }

  // ---------- Images Landsat : température de surface et végétation ----------
  function defUtm(item) {
    const code = String(item.properties["proj:code"] || item.properties["proj:epsg"] || "").replace("EPSG:", "");
    const zone = +code.slice(-2), sud = code.startsWith("327");
    if (!zone) throw new Error("projection de l'image inconnue");
    return `+proj=utm +zone=${zone}${sud ? " +south" : ""} +datum=WGS84 +units=m +no_defs`;
  }
  async function chercherScenes(bbox, outreMer) {
    const an = new Date().getFullYear();
    const corps = {
      collections: ["landsat-c2-l2"], bbox, datetime: `${an - 5}-01-01T00:00:00Z/${an}-12-31T23:59:59Z`,
      query: { "eo:cloud_cover": { lt: NUAGES_MAX }, platform: { in: ["landsat-8", "landsat-9"] } },
      sortby: [{ field: "eo:cloud_cover", direction: "asc" }], limit: 250,
    };
    const rep = await json(STAC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) });
    const coins = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]];
    const bonnes = rep.features.filter((f) => {
      const mois = +f.properties.datetime.slice(5, 7);
      if (!outreMer && (mois < 6 || mois > 8)) return false;      // été météorologique dans l'Hexagone
      if (!f.assets.lwir11 || !f.assets.qa_pixel) return false;
      return coins.every((c) => dansGeometrie(c[0], c[1], f.geometry));
    });
    // On garde une seule trace au sol (même grille de pixels d'une date à l'autre).
    const groupes = new Map();
    for (const f of bonnes) {
      const cle = f.properties["landsat:wrs_path"] + "/" + f.properties["landsat:wrs_row"];
      if (!groupes.has(cle)) groupes.set(cle, []);
      groupes.get(cle).push(f);
    }
    let meilleur = [];
    for (const g of groupes.values()) if (g.length > meilleur.length) meilleur = g;
    return meilleur;
  }

  async function lireFenetre(url, col0, lig0, W, H) {
    const tiff = await GeoTIFF.fromUrl(url);
    const image = await tiff.getImage();
    const [ox, oy] = image.getOrigin();
    const c = Math.round((col0 - ox) / 30), l = Math.round((oy - lig0) / 30);
    const r = await image.readRasters({ window: [c, l, c + W, l + H], fillValue: 0 });
    return r[0];
  }

  async function calculerChaleur(commune, outreMer) {
    const geom = commune.geometry;
    let [x0, y0, x1, y1] = commune.bbox;
    etape("sat", "Recherche d'images Landsat d'été sans nuage…");
    const scenes = await chercherScenes([x0, y0, x1, y1], outreMer);
    if (!scenes.length) throw new Error("aucune image Landsat sans nuage couvrant toute la commune sur les cinq dernières années");
    const utm = defUtm(scenes[0]);
    const versUtm = proj4("EPSG:4326", utm);
    // Emprise en mètres, calée sur la grille Landsat (bords de pixel à 15 m près des multiples de 30).
    const xs = [], ys = [];
    for (const [lon, lat] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) { const p = versUtm.forward([lon, lat]); xs.push(p[0]); ys.push(p[1]); }
    const cale = (v, bas) => (bas ? Math.floor((v - 15) / 30) : Math.ceil((v - 15) / 30)) * 30 + 15;
    const gauche = cale(Math.min(...xs), true) - 60, droite = cale(Math.max(...xs), false) + 60;
    const bas = cale(Math.min(...ys), true) - 60, haut = cale(Math.max(...ys), false) + 60;
    const W = Math.round((droite - gauche) / 30), H = Math.round((haut - bas) / 30), N = W * H;

    // Masque de la commune sur la grille des pixels.
    const toile = document.createElement("canvas"); toile.width = W; toile.height = H;
    const ctx = toile.getContext("2d", { willReadFrequently: true });
    for (const poly of polygones(geom)) {
      ctx.beginPath();
      for (const anneau of poly) {
        anneau.forEach(([lon, lat], i) => {
          const p = versUtm.forward([lon, lat]);
          const px = (p[0] - gauche) / 30, py = (haut - p[1]) / 30;
          if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        });
        ctx.closePath();
      }
      ctx.fill("evenodd");
    }
    const alpha = ctx.getImageData(0, 0, W, H).data;
    const masque = new Uint8Array(N); let nMasque = 0;
    for (let i = 0; i < N; i++) if (alpha[i * 4 + 3] > 127) { masque[i] = 1; nMasque++; }

    const jeton = (await json(JETON)).token;
    const retenues = [];
    const candidates = scenes.slice(0, outreMer ? 14 : NB_SCENES + 3);
    etape("sat", `Lecture de ${candidates.length} images Landsat (thermique, rouge, proche infrarouge)…`);
    await Promise.all(candidates.map(async (f) => {
      try {
        const lire = (nom) => lireFenetre(f.assets[nom].href + "?" + jeton, gauche, haut, W, H);
        const [st, rouge, pir, qa] = await Promise.all([lire("lwir11"), lire("red"), lire("nir08"), lire("qa_pixel")]);
        const lst = new Float32Array(N), ndvi = new Float32Array(N);
        let valides = 0, somme = 0;
        for (let i = 0; i < N; i++) {
          // qa_pixel : bits 1 à 5 = nuage dilaté, cirrus, nuage, ombre, neige ; bit 0 = hors image.
          if (st[i] === 0 || (qa[i] & 63) !== 0) { lst[i] = NaN; ndvi[i] = NaN; continue; }
          lst[i] = st[i] * 0.00341802 + 149 - 273.15;
          const r = rouge[i] * 0.0000275 - 0.2, n = pir[i] * 0.0000275 - 0.2;
          ndvi[i] = (n + r) > 0 ? (n - r) / (n + r) : NaN;
          if (masque[i]) { valides++; somme += lst[i]; }
        }
        if (valides / nMasque >= PART_REPLI) {
          retenues.push({ part: valides / nMasque, id: f.id, date: f.properties.datetime.slice(0, 10), heure: f.properties.datetime.slice(11, 16), satellite: f.properties.platform, nuages: f.properties["eo:cloud_cover"], moyenne: somme / valides, lst, ndvi });
        }
      } catch (e) { console.warn("Image ignorée", f.id, e); }
    }));
    if (!retenues.length) throw new Error(outreMer ? "la température de surface Landsat n'est pas produite sur ce territoire, ou les images sont nuageuses" : "les images trouvées sont nuageuses ou illisibles au-dessus de la commune");
    // Images dégagées d'abord ; à défaut, images en partie nuageuses (les trous sont comblés par les autres dates).
    const nettes = retenues.filter((s) => s.part >= PART_VALIDE_MIN);
    const partielles = nettes.length < 2;
    const choix = partielles ? retenues.sort((a, b) => b.part - a.part) : nettes.sort((a, b) => a.nuages - b.nuages);
    const gardees = choix.slice(0, NB_SCENES).sort((a, b) => a.date.localeCompare(b.date));

    // Médiane par pixel sur les dates gardées.
    const lst = new Float32Array(N), ndvi = new Float32Array(N), tmp = [];
    const med = (cle, i) => {
      tmp.length = 0;
      for (const s of gardees) { const v = s[cle][i]; if (v === v) tmp.push(v); }
      if (!tmp.length) return NaN;
      tmp.sort((a, b) => a - b);
      const m = tmp.length >> 1;
      return tmp.length % 2 ? tmp[m] : (tmp[m - 1] + tmp[m]) / 2;
    };
    for (let i = 0; i < N; i++) { lst[i] = med("lst", i); ndvi[i] = med("ndvi", i); }

    // Statistiques sur la commune.
    const vl = [], vn = [];
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, n = 0;
    for (let i = 0; i < N; i++) {
      if (!masque[i] || lst[i] !== lst[i]) continue;
      vl.push(lst[i]);
      if (ndvi[i] === ndvi[i]) { vn.push(ndvi[i]); n++; sx += ndvi[i]; sy += lst[i]; sxx += ndvi[i] * ndvi[i]; sxy += ndvi[i] * lst[i]; syy += lst[i] * lst[i]; }
    }
    const tl = Float64Array.from(vl).sort(), tn = Float64Array.from(vn).sort();
    const covar = sxy - sx * sy / n, varx = sxx - sx * sx / n, vary = syy - sy * sy / n;
    const m = quantile(tl, 0.5), p2 = quantile(tl, 0.02), p98 = quantile(tl, 0.98);
    const stats = {
      mediane: m, p10: quantile(tl, 0.1), p90: quantile(tl, 0.9), seuilChaud: quantile(tl, 0.8),
      borne: Math.max(2, Math.ceil(Math.max(m - p2, p98 - m))),
      ndviMedian: quantile(tn, 0.5),
      partVegetale: vn.filter((v) => v >= 0.5).length / vn.length,
      partMinerale: vn.filter((v) => v < 0.2).length / vn.length,
      pente: covar / varx, correlation: covar / Math.sqrt(varx * vary),
      pixels: vl.length, surfaceHa: nMasque * 0.09, couverture: vl.length / nMasque, partielles,
    };
    return Object.assign(stats, {
      utm, gauche, haut, W, H, lst, ndvi, masque,
      scenes: gardees.map(({ id, date, heure, satellite, nuages, moyenne }) => ({ id, date, heure, satellite, nuages, moyenne })),
    });
  }

  // Valeur d'une grille Landsat en un point (coordonnées UTM).
  function indice(ch, x, y) {
    const c = Math.floor((x - ch.gauche) / 30), l = Math.floor((ch.haut - y) / 30);
    return (c < 0 || l < 0 || c >= ch.W || l >= ch.H) ? -1 : l * ch.W + c;
  }

  // Images à poser sur la carte : on rééchantillonne en Mercator, la projection de la carte.
  function calques(ch, bbox) {
    const versUtm = proj4("EPSG:4326", ch.utm);
    const [x0, y0, x1, y1] = bbox;
    const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const m0 = merc(y0), m1 = merc(y1);
    const ech = Math.min(1, Math.sqrt(1.5e6 / (ch.W * ch.H)));
    const OW = Math.max(2, Math.round(ch.W * ech)), OH = Math.max(2, Math.round(ch.H * ech));
    const source = new Int32Array(OW * OH);
    for (let j = 0; j < OH; j++) {
      const lat = (Math.atan(Math.exp(m1 - ((j + 0.5) / OH) * (m1 - m0))) * 360) / Math.PI - 90;
      for (let i = 0; i < OW; i++) {
        const p = versUtm.forward([x0 + ((i + 0.5) / OW) * (x1 - x0), lat]);
        const k = indice(ch, p[0], p[1]);
        source[j * OW + i] = (k >= 0 && ch.masque[k]) ? k : -1;
      }
    }
    const dessiner = (valeur) => {
      const t = document.createElement("canvas"); t.width = OW; t.height = OH;
      const c = t.getContext("2d"), img = c.createImageData(OW, OH);
      for (let i = 0; i < OW * OH; i++) {
        const k = source[i];
        if (k < 0) continue;
        const rvb = valeur(k);
        if (!rvb) continue;
        img.data[i * 4] = rvb[0]; img.data[i * 4 + 1] = rvb[1]; img.data[i * 4 + 2] = rvb[2]; img.data[i * 4 + 3] = 255;
      }
      c.putImageData(img, 0, 0);
      return L.imageOverlay(t.toDataURL("image/png"), [[y0, x0], [y1, x1]], { pane: "analyse", interactive: false });
    };
    return {
      lst: dessiner((k) => ch.lst[k] === ch.lst[k] ? couleurRampe(R_ECART, 0.5 + (ch.lst[k] - ch.mediane) / (2 * ch.borne)) : null),
      ndvi: dessiner((k) => ch.ndvi[k] === ch.ndvi[k] ? couleurRampe(R_NDVI, ch.ndvi[k] / 0.8) : null),
    };
  }

  // Code de la commune qui contient le point (la commune elle-même, ou le membre d'un groupement).
  function codeEn(commune, lon, lat) {
    if (!commune.membres) return dansGeometrie(lon, lat, commune.geometry) ? commune.properties.code : null;
    for (const m of commune.membres) {
      if (lon < m.bbox[0] || lon > m.bbox[2] || lat < m.bbox[1] || lat > m.bbox[3]) continue;
      if (dansGeometrie(lon, lat, m.geometry)) return m.code;
    }
    return null;
  }
  function emprise(geom) {
    const xs = [], ys = [];
    for (const poly of polygones(geom)) for (const [x, y] of poly[0]) { xs.push(x); ys.push(y); }
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  async function enParallele(elements, n, f) {
    const sortie = new Array(elements.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, elements.length) }, async () => {
      while (i < elements.length) { const k = i++; sortie[k] = await f(elements[k], k); }
    }));
    return sortie;
  }

  // ---------- Carreaux INSEE de 200 m ----------
  let indexCarreaux = null;
  async function chargerCarreaux(commune, deps, ch) {
    if (!indexCarreaux) indexCarreaux = await json("data/carreaux/index.json");
    const [x0, y0, x1, y1] = commune.bbox;
    const cellules = [], vus = new Set();
    let info = null;
    for (const dep of deps) {
     if (!indexCarreaux[dep]) continue;
     info = indexCarreaux[dep];
     const texte = await (await fetch(`data/carreaux/${dep}.csv`)).text();
     const crs = "EPSG:" + info.epsg;
     const versGeo = proj4(crs, "EPSG:4326");
     const versUtm = ch ? proj4(crs, ch.utm) : null;
     const lignes = texte.split("\n");
     for (let i = 1; i < lignes.length; i++) {
      if (!lignes[i]) continue;
      const v = lignes[i].split(",");
      const n = +v[0] * 200, e = +v[1] * 200;
      const centre = versGeo.forward([e + 100, n + 100]);
      if (centre[0] < x0 || centre[0] > x1 || centre[1] < y0 || centre[1] > y1) continue;
      const code = codeEn(commune, centre[0], centre[1]);
      if (!code || vus.has(v[0] + "_" + v[1])) continue;   // un carreau à cheval figure dans deux fichiers
      vus.add(v[0] + "_" + v[1]);
      const c = {
        code, n, e, estime: v[2] === "1", ind: +v[3], men: +v[4], pauv: +v[5], snv: +v[6],
        jeunes: +v[7] + +v[8], ages: +v[10] + +v[11], ages80: +v[11],
        coins: [[e, n], [e + 200, n], [e + 200, n + 200], [e, n + 200]].map((p) => { const g = versGeo.forward(p); return [g[1], g[0]]; }),
        lst: NaN, ndvi: NaN,
      };
      if (ch) {
        let sl = 0, nl = 0, sn = 0, nn = 0;
        for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) {
          const p = versUtm.forward([e + 20 + a * 40, n + 20 + b * 40]);
          const k = indice(ch, p[0], p[1]);
          if (k < 0) continue;
          if (ch.lst[k] === ch.lst[k]) { sl += ch.lst[k]; nl++; }
          if (ch.ndvi[k] === ch.ndvi[k]) { sn += ch.ndvi[k]; nn++; }
        }
        if (nl) c.lst = sl / nl;
        if (nn) c.ndvi = sn / nn;
      }
      cellules.push(c);
     }
    }
    if (!cellules.length) return null;

    // Score de priorité : moyenne de trois rangs dans le territoire étudié (chaleur, âge, pauvreté).
    const rC = rangs(cellules.map((c) => c.lst));
    const rA = rangs(cellules.map((c) => c.jeunes + c.ages));
    const rP = rangs(cellules.map((c) => c.men > 0 ? c.pauv / c.men : NaN));
    cellules.forEach((c, i) => {
      c.score = (isFinite(rC[i]) && isFinite(rP[i])) ? 100 * (rC[i] + rA[i] + rP[i]) / 3 : NaN;
      c.chaud = ch ? c.lst >= ch.seuilChaud : false;
    });
    const somme = (f, filtre) => cellules.reduce((s, c) => s + ((!filtre || filtre(c)) ? f(c) : 0), 0);
    const chaud = (c) => c.chaud;
    const tot = {
      nb: cellules.length, estimes: cellules.filter((c) => c.estime).length,
      ind: somme((c) => c.ind), men: somme((c) => c.men), pauv: somme((c) => c.pauv),
      jeunes: somme((c) => c.jeunes), ages: somme((c) => c.ages), ages80: somme((c) => c.ages80),
    };
    if (ch) Object.assign(tot, {
      nbChauds: cellules.filter(chaud).length,
      indChaud: somme((c) => c.ind, chaud), pauvChaud: somme((c) => c.pauv, chaud),
      jeunesChaud: somme((c) => c.jeunes, chaud), agesChaud: somme((c) => c.ages, chaud),
    });
    if (ch && tot.ind > 0) {
      // Température de surface au-dessus de laquelle vit le cinquième des habitants le plus exposé.
      const tri = cellules.filter((c) => isFinite(c.lst)).sort((a, b) => b.lst - a.lst);
      let cumul = 0;
      for (const c of tri) { cumul += c.ind; if (cumul >= 0.2 * tot.ind) { tot.seuilHabitants = c.lst; break; } }
    }
    return { cellules, tot, epsg: info.epsg };
  }
  function coucheCarreaux(d) {
    const groupe = L.featureGroup([], { pane: "carreaux" });
    for (const c of d.carreaux.cellules) {
      if (!isFinite(c.score)) continue;
      const classe = Math.min(4, Math.floor(c.score / 20));
      L.polygon(c.coins, { pane: "carreaux", color: "#fcfcfb", weight: 1, fillColor: CLASSES_SCORE[classe], fillOpacity: 0.82 })
        .bindTooltip(() => `<div class="infobulle"><b>Carreau de 200 m</b>${c.estime ? " (valeurs estimées par l'INSEE)" : ""}<br>
          ${fmt(c.ind)} habitants, dont ${fmt(c.ages)} de 65 ans ou plus et ${fmt(c.jeunes)} de moins de 6 ans<br>
          Ménages pauvres : ${fmt(100 * c.pauv / c.men)} %<br>
          Surface : ${signe(c.lst - d.chaleur.mediane)} °C par rapport à la médiane · NDVI ${fmt(c.ndvi, 2)}<br>
          Priorité : <b>${fmt(c.score)} / 100</b></div>`, { sticky: true })
        .addTo(groupe);
    }
    return groupe;
  }

  // ---------- Lieux sensibles (BPE) ----------
  async function chargerSites(commune, deps, ch) {
    const lignes = [""];
    let lus = 0;
    for (const dep of deps) {
      const r = await fetch(`data/equipements/${dep}.tsv`);
      if (!r.ok) continue;
      lus++;
      lignes.push(...(await r.text()).split("\n").slice(1));
    }
    if (!lus) return null;
    const versUtm = ch ? proj4("EPSG:4326", ch.utm) : null;
    const [x0, y0, x1, y1] = commune.bbox, sites = [];
    const rayon = Math.ceil(RAYON_SITE_M / 30);
    for (let i = 1; i < lignes.length; i++) {
      const v = lignes[i].split("\t");
      if (v.length < 6) continue;
      const lon = +v[4], lat = +v[5];
      if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
      const code = codeEn(commune, lon, lat);
      if (!code) continue;
      const s = { code, type: v[1], nom: v[3], lon, lat, capacite: v[6] ? +v[6] : null, qualite: (v[7] || "").trim(), lst: NaN, ndvi: NaN };
      if (ch) {
        const p = versUtm.forward([lon, lat]);
        const c0 = Math.floor((p[0] - ch.gauche) / 30), l0 = Math.floor((ch.haut - p[1]) / 30);
        let sl = 0, nl = 0, sn = 0, nn = 0;
        for (let dl = -rayon; dl <= rayon; dl++) for (let dc = -rayon; dc <= rayon; dc++) {
          if (dl * dl + dc * dc > rayon * rayon + 1) continue;
          const c = c0 + dc, l = l0 + dl;
          if (c < 0 || l < 0 || c >= ch.W || l >= ch.H) continue;
          const k = l * ch.W + c;
          if (ch.lst[k] === ch.lst[k]) { sl += ch.lst[k]; nl++; }
          if (ch.ndvi[k] === ch.ndvi[k]) { sn += ch.ndvi[k]; nn++; }
        }
        if (nl) s.lst = sl / nl;
        if (nn) s.ndvi = sn / nn;
        s.chaud = s.lst >= ch.seuilChaud;
      }
      sites.push(s);
    }
    sites.sort((a, b) => (isFinite(b.lst) ? b.lst : -1e9) - (isFinite(a.lst) ? a.lst : -1e9));
    return sites;
  }
  function coucheSites(d) {
    const groupe = L.featureGroup();
    for (const s of d.sites) {
      const t = TYPES[s.type];
      const icone = L.divIcon({ className: "site", html: `<span class="puce ${s.type}${s.chaud ? " chaud" : ""}">${t.lettre}</span>`, iconSize: [18, 18], iconAnchor: [9, 9] });
      L.marker([s.lat, s.lon], { icon: icone, keyboard: false })
        .bindTooltip(`<div class="infobulle"><b>${echappe(s.nom)}</b><br>${t.nom}${s.capacite ? " · capacité " + fmt(s.capacite) : ""}<br>
          ${d.chaleur ? `Surface dans un rayon de 100 m : ${signe(s.lst - d.chaleur.mediane)} °C par rapport à la médiane<br>NDVI ${fmt(s.ndvi, 2)}` : ""}</div>`)
        .addTo(groupe);
    }
    return groupe;
  }

  // ---------- Lieux de fraîcheur (OpenStreetMap) ----------
  async function overpass(requete, serveurs, delaiS, pauseS) {
    let derniere = null;
    for (const serveur of serveurs) {
      if (derniere && pauseS) await new Promise((suite) => setTimeout(suite, pauseS * 1000));
      const arret = new AbortController();
      const minuteur = setTimeout(() => arret.abort(), delaiS * 1000);
      try {
        const r = await fetch(serveur, { method: "POST", body: "data=" + encodeURIComponent(requete), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: arret.signal });
        if (!r.ok) throw new Error("réponse " + r.status);
        const d = await r.json();
        if (d.remark && /error|timed out/i.test(d.remark)) throw new Error(d.remark);
        return d;
      } catch (e) { derniere = e; } finally { clearTimeout(minuteur); }
    }
    throw new Error(derniere && derniere.name === "AbortError" ? "délai dépassé" : String(derniere && derniere.message));
  }
  // Parcs, jardins publics et bois ; « out geom » donne aussi la géométrie des membres des relations.
  function requeteFraicheur(bb) {
    return `[out:json][timeout:90][bbox:${bb}];
    (
      way["leisure"~"^(park|garden|nature_reserve)$"]; way["landuse"="forest"]; way["natural"="wood"];
      relation["leisure"~"^(park|garden|nature_reserve)$"]; relation["landuse"="forest"]; relation["natural"="wood"];
    );
    out geom;`;
  }
  function margeEmprise(b, m) {
    const dLat = m / 111320, dLon = m / (111320 * Math.cos(((b[1] + b[3]) / 2) * Math.PI / 180));
    return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat];
  }
  const utmDe = (lon, lat) => `+proj=utm +zone=${Math.floor((lon + 180) / 6) + 1}${lat < 0 ? " +south" : ""} +datum=WGS84 +units=m +no_defs`;
  // Relevé enregistré pour les territoires d'exemple (R/05_fraicheur.R), sinon requête en direct.
  async function chargerFraicheur(code, commune) {
    const r = await fetch(`data/fraicheur/${code}.json`).catch(() => null);
    if (r && r.ok) return Object.assign(await r.json(), { enregistre: true });
    const b = margeEmprise(commune.bbox, MARGE_FRAIS_M);
    const km2 = (b[2] - b[0]) * 111.32 * Math.cos(((b[1] + b[3]) / 2) * Math.PI / 180) * (b[3] - b[1]) * 111.32;
    if (km2 > EMPRISE_MAX_KM2) throw new Error("territoire trop étendu pour une requête en direct");
    return overpass(requeteFraicheur([b[1], b[0], b[3], b[2]].map((v) => v.toFixed(5)).join(",")), OVERPASS, 60, 3);
  }
  // Abscisses où une ligne horizontale coupe les arêtes (règle pair-impair : trous et anneaux en morceaux gérés).
  function coupures(aretes, y) {
    const xs = [];
    for (const a of aretes) if ((a[1] > y) !== (a[3] > y)) xs.push(a[0] + (y - a[1]) * (a[2] - a[0]) / (a[3] - a[1]));
    return xs.sort((p, q) => p - q);
  }
  function dansAretes(aretes, x, y) {
    let n = 0;
    for (const a of aretes) if ((a[1] > y) !== (a[3] > y) && x < a[0] + (y - a[1]) * (a[2] - a[0]) / (a[3] - a[1])) n++;
    return n % 2 === 1;
  }
  function distanceLieu(l, x, y, limite) {
    if (x < l.x0 - limite || x > l.x1 + limite || y < l.y0 - limite || y > l.y1 + limite) return Infinity;
    if (dansAretes(l.aretes, x, y)) return 0;
    let mini = Infinity;
    for (const [ax, ay, bx, by] of l.aretes) {
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
      const dd = Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (dd < mini) mini = dd;
    }
    return mini;
  }
  function analyserFraicheur(osm, d) {
    const commune = d.commune, ch = d.chaleur, [b0, b1, b2, b3] = commune.bbox;
    const P = proj4("EPSG:4326", ch ? ch.utm : utmDe((b0 + b2) / 2, (b1 + b3) / 2));
    const tous = [];
    for (const e of osm.elements || []) {
      const t = e.tags || {};
      if (t.access === "private" || t.access === "no" || /^(residential|private)$/.test(t["garden:type"] || "")) continue;
      const traits = [];
      if (e.type === "way" && e.geometry && e.geometry.length > 3) {
        const p = e.geometry[0], q = e.geometry[e.geometry.length - 1];
        if (Math.abs(p.lat - q.lat) < 1e-6 && Math.abs(p.lon - q.lon) < 1e-6) traits.push({ role: "outer", pts: e.geometry });
      } else if (e.type === "relation" && e.members) {
        for (const m of e.members) if (m.geometry && m.geometry.length > 1) traits.push({ role: m.role, pts: m.geometry });
      }
      if (!traits.length) continue;
      const aretes = [];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const tr of traits) {
        let prec = null;
        for (const pt of tr.pts) {
          const q = P.forward([pt.lon, pt.lat]);
          if (prec) aretes.push([prec[0], prec[1], q[0], q[1]]);
          prec = q;
          if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1];
        }
      }
      // Surface et point représentatif : lignes horizontales tous les 5 m.
      let surface = 0, sx = 0, sy = 0;
      for (let y = y0 + 2.5; y < y1; y += 5) {
        const xs = coupures(aretes, y);
        for (let k = 0; k + 1 < xs.length; k += 2) { const lg = xs[k + 1] - xs[k]; surface += lg * 5; sx += (xs[k] + xs[k + 1]) / 2 * lg * 5; sy += y * lg * 5; }
      }
      if (surface < FRAIS_MIN_HA * 10000) continue;
      let cx = sx / surface, cy = sy / surface;
      if (!dansAretes(aretes, cx, cy)) {   // forme en croissant : on prend le milieu de la ligne la plus longue
        let meilleur = -1;
        for (let y = y0 + 2.5; y < y1; y += 5) { const xs = coupures(aretes, y); for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1] - xs[k] > meilleur) { meilleur = xs[k + 1] - xs[k]; cx = (xs[k] + xs[k + 1]) / 2; cy = y; } }
      }
      const g = P.inverse([cx, cy]);
      const l = { nom: t.name || "", type: (t.landuse === "forest" || t.natural === "wood") ? "bois" : "parc", surface, aretes, traits, x0, y0, x1, y1, lon: g[0], lat: g[1], code: codeEn(commune, g[0], g[1]), ecart: NaN, ndvi: NaN, pixels: 0 };
      // Température de surface mesurée sur les pixels Landsat dont le centre est dans le lieu.
      if (ch) {
        let sl = 0, nl = 0, sn = 0, nn = 0;
        const lA = Math.max(0, Math.floor((ch.haut - y1) / 30)), lB = Math.min(ch.H - 1, Math.ceil((ch.haut - y0) / 30));
        for (let li = lA; li <= lB; li++) {
          const xs = coupures(aretes, ch.haut - (li + 0.5) * 30);
          for (let k = 0; k + 1 < xs.length; k += 2) {
            const cA = Math.max(0, Math.ceil((xs[k] - ch.gauche) / 30 - 0.5)), cB = Math.min(ch.W - 1, Math.floor((xs[k + 1] - ch.gauche) / 30 - 0.5));
            for (let c = cA; c <= cB; c++) {
              const i = li * ch.W + c;
              if (ch.lst[i] === ch.lst[i]) { sl += ch.lst[i]; nl++; }
              if (ch.ndvi[i] === ch.ndvi[i]) { sn += ch.ndvi[i]; nn++; }
            }
          }
        }
        if (nl >= 4) { l.ecart = sl / nl - ch.mediane; l.pixels = nl; }
        if (nn >= 4) l.ndvi = sn / nn;
      }
      l.frais = l.ecart <= ECART_FRAIS;
      tous.push(l);
    }
    // Un jardin dans un parc, un bois dans un parc : on ne garde dans la liste que le plus grand.
    tous.sort((a, b) => b.surface - a.surface);
    const gardes = [];
    for (const l of tous) {
      const [x, y] = P.forward([l.lon, l.lat]);
      if (!gardes.some((m) => dansAretes(m.aretes, x, y))) gardes.push(l);
    }
    const lieux = gardes.filter((l) => l.code);
    const plusProche = (lon, lat) => {
      const [x, y] = P.forward([lon, lat]);
      let mini = Infinity;
      for (const l of tous) { const dd = distanceLieu(l, x, y, 1500); if (dd < mini) mini = dd; if (!mini) break; }
      return mini;
    };
    const proches = { ind: 0, ages: 0, jeunes: 0 };
    if (d.carreaux) for (const c of d.carreaux.cellules) {
      const lat = c.coins.reduce((s, q) => s + q[0], 0) / 4, lon = c.coins.reduce((s, q) => s + q[1], 0) / 4;
      c.distFrais = plusProche(lon, lat);
      if (c.distFrais <= PROCHE_FRAIS_M) { proches.ind += c.ind; proches.ages += c.ages; proches.jeunes += c.jeunes; }
    }
    for (const s of d.sites || []) s.distFrais = plusProche(s.lon, s.lat);
    return { tous, lieux, proches, enregistre: !!osm.enregistre, date: osm.date || null };
  }
  function coucheFraicheur(d) {
    const groupe = L.featureGroup();
    for (const l of d.frais.tous) {
      const infobulle = `<div class="infobulle"><b>${echappe(l.nom || (l.type === "bois" ? "Bois" : "Parc ou jardin public") + " sans nom")}</b><br>
        ${l.type === "bois" ? "Bois" : "Parc ou jardin public"} · ${fmt(l.surface / 10000, 1)} ha<br>
        ${isFinite(l.ecart) ? `Surface : ${signe(l.ecart)} °C par rapport à la médiane${l.frais ? " (fraîcheur mesurée)" : ""}` : "Température de surface non mesurée"}</div>`;
      const style = { color: "#0e7a52", weight: 1.5, fillColor: "#1baf7a", fillOpacity: l.frais ? 0.5 : 0.18 };
      for (const tr of l.traits) {
        if (tr.role === "inner") continue;
        const ll = tr.pts.map((q) => [q.lat, q.lon]), a = tr.pts[0], b = tr.pts[tr.pts.length - 1];
        const ferme = tr.pts.length > 3 && Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
        (ferme ? L.polygon(ll, style) : L.polyline(ll, { color: style.color, weight: 1.5 })).bindTooltip(infobulle, { sticky: true }).addTo(groupe);
      }
    }
    return groupe;
  }

  // ---------- Actions proposées (règles fixes, les mêmes pour tous les territoires) ----------
  function proposerActions(d) {
    const A = [], ch = d.chaleur, ca = d.carreaux, f = d.frais, sites = d.sites || [];
    const ajouter = (priorite, theme, lieu, constat, proposition, partenaire, lon, lat) => A.push({ priorite, theme, lieu, constat, proposition, partenaire, lon: lon == null ? null : lon, lat: lat == null ? null : lat });
    const ha = (m2) => fmt(m2 / 10000, 1) + " ha";
    if (ch) {
      // Écoles et crèches dans le cinquième le plus chaud, les plus chaudes d'abord.
      const enfants = sites.filter((s) => s.chaud && (s.type === "ecole" || s.type === "creche"));
      for (const s of enfants.slice(0, 8)) ajouter(s.ndvi < 0.2 ? 1 : 2, "Établissements sensibles", `${s.nom} (${TYPES[s.type].nom.toLowerCase()})`,
        `Surface ${signe(s.lst - ch.mediane)} °C par rapport à la médiane dans un rayon de ${RAYON_SITE_M} m ; NDVI ${fmt(s.ndvi, 2)}${s.ndvi < 0.2 ? " (abords très minéraux)" : ""}`,
        s.type === "ecole" ? "Désimperméabiliser et ombrager la cour (arbres, pleine terre, revêtements clairs), protéger les classes du soleil ; ouvrir la cour aux habitants l'été" : "Ombrager l'espace extérieur, protéger les salles du soleil, vérifier le dispositif de rafraîchissement",
        s.type === "ecole" ? "Direction de l'éducation ; direction des bâtiments" : "Direction de la petite enfance ; direction des bâtiments", s.lon, s.lat);
      if (enfants.length > 8) ajouter(2, "Établissements sensibles", `${fmt(enfants.length - 8)} autres écoles et crèches`, "Également dans le cinquième le plus chaud (liste complète dans l'export des lieux sensibles)", "Même démarche, à programmer après les établissements ci-dessus", "Direction de l'éducation ; direction de la petite enfance");
      for (const s of sites.filter((s) => s.chaud && s.type === "ehpad")) ajouter(1, "Établissements sensibles", s.nom,
        `Hébergement pour personnes âgées dans le cinquième le plus chaud${s.capacite ? ", " + fmt(s.capacite) + " places" : ""} ; surface ${signe(s.lst - ch.mediane)} °C par rapport à la médiane`,
        "Vérifier avec l'établissement son plan bleu et son dispositif de rafraîchissement ; végétaliser et ombrager les abords", "Établissement ; CCAS ; Agence régionale de santé", s.lon, s.lat);
    }
    if (ch && ca) {
      const forts = ca.cellules.filter((c) => c.score >= 80).sort((a, b) => b.score - a.score);
      if (forts.length) {
        const somme = (k) => forts.reduce((s, c) => s + c[k], 0), avecT = forts.filter((c) => isFinite(c.lst));
        const top = forts[0], lat = top.coins.reduce((s, q) => s + q[0], 0) / 4, lon = top.coins.reduce((s, q) => s + q[1], 0) / 4;
        ajouter(1, "Espace public", `${fmt(forts.length)} carreaux de priorité forte (carte, « Carreaux de priorité »)`,
          `${fmt(somme("ind"))} habitants, dont ${fmt(somme("ages"))} de 65 ans ou plus ; surface ${signe(avecT.reduce((s, c) => s + c.lst, 0) / avecT.length - ch.mediane)} °C en moyenne par rapport à la médiane ; NDVI moyen ${fmt(avecT.reduce((s, c) => s + (isFinite(c.ndvi) ? c.ndvi : 0), 0) / avecT.length, 2)}`,
          "Programmer plantations d'arbres, désimperméabilisation et ombrage des rues et des places de ces secteurs ; y prévoir fontaines et bancs à l'ombre", "Direction de l'espace public ; service des espaces verts ; bailleurs sociaux", lon, lat);
      }
      if (ca.tot.agesChaud > 0) ajouter(ca.tot.agesChaud >= 500 ? 1 : 2, "Canicule", "Habitants de 65 ans et plus des secteurs chauds",
        `${fmt(ca.tot.agesChaud)} personnes de 65 ans ou plus vivent dans le cinquième le plus chaud du territoire`,
        "Démarcher ces quartiers pour l'inscription au registre des personnes vulnérables (registre canicule) ; appels et visites pendant les alertes", "CCAS ; associations de quartier");
    }
    if (f && ca && ca.tot.ages > 0 && ca.tot.jeunes > 0) {
      const loinA = 1 - f.proches.ages / ca.tot.ages, loinJ = 1 - f.proches.jeunes / ca.tot.jeunes, pire = Math.max(loinA, loinJ);
      if (pire >= 0.2) ajouter(pire >= 0.4 ? 1 : 2, "Lieux de fraîcheur", `Quartiers sans lieu frais à moins de ${PROCHE_FRAIS_M} m`,
        `${fmt(100 * loinA)} % des 65 ans et plus et ${fmt(100 * loinJ)} % des moins de 6 ans vivent à plus de ${PROCHE_FRAIS_M} m d'un parc, d'un jardin public ou d'un bois d'au moins ${fmt(FRAIS_MIN_HA, 1)} ha`,
        "Ouvrir des lieux frais de proximité pendant les canicules (cours d'école, salles rafraîchies, parcs ouverts en soirée) ; créer des jardins de poche dans ces quartiers", "Direction de l'aménagement ; direction de l'éducation ; CCAS");
      const loin = sites.filter((s) => (s.type === "creche" || s.type === "ehpad") && s.distFrais > PROCHE_FRAIS_M);
      if (loin.length) ajouter(2, "Lieux de fraîcheur", `${fmt(loin.length)} crèche${loin.length > 1 ? "s" : ""} ou hébergement${loin.length > 1 ? "s" : ""} pour personnes âgées`,
        `À plus de ${PROCHE_FRAIS_M} m de tout lieu de fraîcheur : ${loin.slice(0, 4).map((s) => s.nom).join(", ")}${loin.length > 4 ? "…" : ""}`,
        "Prévoir un lieu frais de repli pour les sorties et les épisodes de canicule ; végétaliser les abords", "Direction de la petite enfance ; CCAS");
      for (const l of f.lieux.filter((l) => l.surface >= 10000 && l.ecart > 0).slice(0, 3)) ajouter(3, "Lieux de fraîcheur", l.nom || `${l.type === "bois" ? "Bois" : "Espace vert"} sans nom (${ha(l.surface)})`,
        `Surface ${signe(l.ecart)} °C par rapport à la médiane : ce lieu n'est pas plus frais que le reste du territoire (NDVI ${fmt(l.ndvi, 2)})`,
        "Augmenter l'ombrage par les arbres, réduire les surfaces minérales, prévoir des points d'eau", "Service des espaces verts", l.lon, l.lat);
    }
    const climat = (id) => d.climat && d.climat.find((l) => l.id === id);
    const s3 = climat("S3"), s2 = climat("S2"), r4 = climat("R4");
    if (s3 && s3.h[1].med != null && s3.h[1].med >= 10) ajouter(2, "Canicule", "Tout le territoire",
      `${fmt(s3.h[1].med)} jours de vague de chaleur par an attendus vers 2050, contre ${fmt(s3.ref)} sur 1976-2005${s2 && s2.h[1].med != null ? ` ; ${fmt(s2.h[1].med)} nuits chaudes au-dessus de 20 °C, contre ${fmt(s2.ref)}` : ""}`,
      "Formaliser un plan de gestion des vagues de chaleur : horaires et conditions de travail des agents, événements, ouverture des lieux frais, information des habitants", "Direction générale des services ; CCAS ; préfecture");
    if (r4 && r4.h[1].med != null && r4.h[1].med >= 20 && f && f.tous.some((l) => l.type === "bois" && l.code)) ajouter(2, "Feux de végétation", "Bois du territoire",
      `${fmt(r4.h[1].med)} jours avec risque significatif de feu de végétation par an attendus vers 2050, contre ${fmt(r4.ref)} sur 1976-2005`,
      "Vérifier les obligations de débroussaillement et l'accès des secours aux bois", "Service des espaces verts ; service départemental d'incendie et de secours");
    const r = d.risques;
    if (r) {
      const nb = (re) => r.catnat.filter((c) => re.test(c.libelle)).reduce((s, c) => s + c.nb, 0);
      const inond = nb(/inondation/i), sech = nb(/s[ée]cheresse/i);
      const cumul = r.nbCommunes > 1 ? `, cumulés sur les ${r.nbCommunes} communes (un même épisode compte une fois par commune touchée)` : "";
      if (inond >= 3) ajouter(2, "Inondation", "Zones inondables",
        `${fmt(inond)} arrêtés de catastrophe naturelle pour inondation depuis 1982${cumul}${r.tri.length ? " ; territoire à risque important d'inondation" : ""}`,
        "Croiser les zones inondables (plan de prévention, Géorisques) avec les écoles, crèches et hébergements pour personnes âgées ; mettre à jour le plan communal de sauvegarde", "Service des risques ; préfecture");
      if (sech) ajouter(sech >= 3 ? 2 : 3, "Sécheresse", "Bâti sur sols argileux",
        `${fmt(sech)} arrêté${sech > 1 ? "s" : ""} de catastrophe naturelle pour mouvements de terrain liés à la sécheresse depuis 1982${cumul}`,
        "Suivre les fissures des bâtiments communaux, informer les propriétaires des règles de construction sur sols argileux", "Direction des bâtiments ; service de l'urbanisme");
    }
    return A.map((a, i) => Object.assign(a, { i })).sort((a, b) => a.priorite - b.priorite || a.i - b.i);
  }

  // ---------- Risques connus (Géorisques) ----------
  async function chargerRisques(codes) {
    const appel = (chemin) => json(`${GEORISQUES}/${chemin}`).catch(() => null);
    const seul = codes.length === 1;
    // Pour un groupement : risques et arrêtés de chaque commune, puis cumul.
    const parCommune = await enParallele(codes, 6, (code) => Promise.all([
      appel(`gaspar/risques?code_insee=${code}`), appel(`gaspar/catnat?code_insee=${code}&page_size=100`)]));
    if (parCommune.every(([r, c]) => !r && !c)) return null;
    const [radon, seisme, tri] = seul ? await Promise.all([
      appel(`radon?code_insee=${codes[0]}`), appel(`zonage_sismique?code_insee=${codes[0]}`), appel(`gaspar/tri?code_insee=${codes[0]}`)]) : [null, null, null];
    const familles = new Map(), precisions = new Set(), parType = new Map();
    let catnatTotal = 0, repondu = 0;
    for (const [risques, catnat] of parCommune) {
      if (risques || catnat) repondu++;
      const detail = (risques && risques.data && risques.data[0] && risques.data[0].risques_detail) || [];
      // Les numéros à deux chiffres sont les grandes familles de risque, les autres leurs précisions.
      for (const r of detail) {
        if (String(r.num_risque).length <= 2) familles.set(r.libelle_risque_long, (familles.get(r.libelle_risque_long) || 0) + 1);
        else precisions.add(r.libelle_risque_long);
      }
      if (catnat) catnatTotal += catnat.results;
      for (const a of (catnat && catnat.data) || []) {
        const annee = +String(a.date_debut_evt).slice(-4);
        const e = parType.get(a.libelle_risque_jo) || { nb: 0, dernier: 0 };
        e.nb++; e.dernier = Math.max(e.dernier, annee); parType.set(a.libelle_risque_jo, e);
      }
    }
    return {
      nbCommunes: codes.length, repondu,
      familles: [...familles.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => seul ? f : `${f} (${n} commune${n > 1 ? "s" : ""} sur ${codes.length})`),
      precisions: seul ? [...precisions] : [],
      catnatTotal,
      catnat: [...parType.entries()].map(([libelle, e]) => ({ libelle, ...e })).sort((a, b) => b.nb - a.nb),
      radon: radon && radon.data && radon.data[0] ? radon.data[0].classe_potentiel : null,
      seisme: seisme && seisme.data && seisme.data[0] ? seisme.data[0].code_zone : null,
      tri: tri && tri.data ? tri.data.map((t) => t.libelle_tri.replace(/\s+/g, " ").trim()) : [],
    };
  }

  // ---------- Climat futur (Climadiag Commune, Météo-France) ----------
  let libellesClimat = null;
  const ORDRE_CLIMAT = ["S3", "S1", "S9", "S2", "S5", "S8", "S10", "S6", "S7", "G1", "R4", "R5", "R1", "R2", "R3"];
  async function chargerClimat(code, dep, groupe) {
    const r = await fetch(`data/climat/${groupe ? "groupements" : dep}.json`);
    if (!r.ok) return null;
    const commune = (await r.json())[code];
    if (!commune) return null;
    if (!libellesClimat) libellesClimat = await json("data/climat/libelles.json");
    const lignes = [];
    for (const id of ORDRE_CLIMAT) {
      const ind = commune[id];
      if (!ind) continue;
      const saisons = Object.keys(ind);
      const saison = saisons.includes("été") ? "été" : saisons[0];
      const v = ind[saison];
      lignes.push({
        id, libelle: (libellesClimat[id] || id) + (saison ? ` (${saison})` : ""),
        ref: v[0], h: [2030, 2050, 2100].map((an, i) => ({ an, bas: v[1 + i * 3], med: v[2 + i * 3], haut: v[3 + i * 3] })),
      });
    }
    return lignes.length ? lignes : null;
  }
  function trident(l) {
    const W = 220, H = 120, g = 14, d = 10, hTop = 18, hBas = 22;
    const vals = [l.ref].concat(l.h.flatMap((x) => [x.bas, x.med, x.haut])).filter((v) => v != null);
    const lo = Math.min(0, ...vals), hi = Math.max(...vals) || 1;
    const y = (v) => hTop + (H - hTop - hBas) * (1 - (v - lo) / (hi - lo || 1));
    const xs = [0, 1, 2, 3].map((i) => g + 22 + i * ((W - g - d - 44) / 3));
    const noms = ["Réf.", "2030", "2050", "2100"];
    let s = `<line x1="${g}" x2="${W - d}" y1="${y(lo)}" y2="${y(lo)}" stroke="#dcdad3"/>`;
    s += `<line x1="${g}" x2="${W - d}" y1="${y(l.ref)}" y2="${y(l.ref)}" stroke="#8c8a82" stroke-dasharray="3 3"/>`;
    s += `<circle cx="${xs[0]}" cy="${y(l.ref)}" r="4" fill="#52514e"><title>Référence 1976-2005 : ${fmt(l.ref, 1)}</title></circle>`;
    s += `<text class="val" x="${xs[0]}" y="${y(l.ref) - 8}" text-anchor="middle">${fmt(l.ref, l.ref % 1 ? 1 : 0)}</text>`;
    l.h.forEach((x, i) => {
      if (x.med == null) return;
      s += `<g><title>${x.an} : médiane ${fmt(x.med, 1)} (de ${fmt(x.bas, 1)} à ${fmt(x.haut, 1)})</title>
        <line x1="${xs[i + 1]}" x2="${xs[i + 1]}" y1="${y(x.haut)}" y2="${y(x.bas)}" stroke="#1c5cab" stroke-width="2" stroke-linecap="round"/>
        <circle cx="${xs[i + 1]}" cy="${y(x.med)}" r="4.5" fill="#1c5cab" stroke="#fff" stroke-width="2"/></g>`;
      s += `<text class="val" x="${xs[i + 1] + 8}" y="${y(x.med) + 4}">${fmt(x.med, x.med % 1 ? 1 : 0)}</text>`;
    });
    noms.forEach((n, i) => { s += `<text x="${xs[i]}" y="${H - 6}" text-anchor="middle">${n}</text>`; });
    return `<div class="trident"><div class="titre">${echappe(l.libelle)}</div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${echappe(l.libelle)}">${s}</svg></div>`;
  }

  // ---------- Fiche ----------
  function telecharger(nom, lignes) {
    const blob = new Blob(["﻿" + lignes.map((l) => l.join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = nom; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const nombre = (v, d = 1) => isFinite(v) ? String(Math.round(v * 10 ** d) / 10 ** d).replace(".", ",") : "";

  function rediger(d) {
    const p = d.commune.properties, ch = d.chaleur, ca = d.carreaux, h = [];
    const G = p.groupe, duT = G ? "du territoire" : "de la commune", adjT = G ? "du territoire" : "communale";
    h.push(`<h2>${echappe(p.nom)}</h2>
      <p class="sous-titre">${G ? `Groupement de ${G.nb} communes` : echappe(p.departement ? p.departement.nom + " (" + p.departement.code + ")" : "") + " · code INSEE " + p.code} · ${fmt(p.population)} habitants · ${fmt(p.surface / 100, 1)} km² · établi le ${new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })} · outil conçu par Césarion Djonel</p>
      ${G ? `<p class="note">${G.noms.map(echappe).join(", ")}.${G.manquantes ? ` ${G.manquantes} commune(s) du groupement n'ont pas pu être chargées.` : ""}</p>` : ""}
      <div class="actions"><button id="imprimer">Imprimer ou enregistrer en PDF</button>
      ${d.actions && d.actions.length ? '<button id="csv-actions">Actions (CSV pour Excel)</button>' : ""}${ca ? '<button id="csv-carreaux">Carreaux (CSV)</button>' : ""}${d.sites && d.sites.length ? '<button id="csv-sites">Lieux sensibles (CSV)</button>' : ""}${d.frais && d.frais.lieux.length ? '<button id="csv-frais">Lieux de fraîcheur (CSV)</button>' : ""}</div>`);

    // Synthèse
    const phrases = [];
    if (ch) phrases.push(`En été, en fin de matinée, la surface du sol et des toits varie de ${fmt(ch.p90 - ch.p10, 1)} °C entre les secteurs les plus frais et les plus chauds ${duT} (du 10<sup>e</sup> au 90<sup>e</sup> centile).`);
    if (ch && ca && ca.tot.ind > 0) phrases.push(`Le cinquième le plus chaud du territoire abrite ${fmt(100 * ca.tot.indChaud / ca.tot.ind)} % des habitants (${fmt(ca.tot.indChaud)} personnes) ; une répartition uniforme en donnerait 20 %.${ca.tot.indChaud / ca.tot.ind < 0.12 ? " Les secteurs les plus chauds sont donc peu habités." : ""}${isFinite(ca.tot.seuilHabitants) ? ` Un habitant sur cinq vit dans un carreau dont la surface dépasse la médiane ${adjT} d'au moins ${fmt(ca.tot.seuilHabitants - ch.mediane, 1)} °C.` : ""}`);
    const nChauds = d.sites ? d.sites.filter((s) => s.chaud).length : 0;
    if (ch && d.sites && d.sites.length) phrases.push(`${fmt(nChauds)} des ${fmt(d.sites.length)} lieux sensibles recensés sont dans ce cinquième le plus chaud.`);
    const s3 = d.climat && d.climat.find((l) => l.id === "S3");
    if (s3 && s3.h[1].med != null) phrases.push(`Météo-France attend ${fmt(s3.h[1].med)} jours de vague de chaleur par an à l'horizon 2050 (valeur médiane), contre ${fmt(s3.ref)} sur la période de référence.`);
    const fr = d.frais;
    if (fr && ca && ca.tot.ages > 0) phrases.push(`${fmt(100 * fr.proches.ages / ca.tot.ages)} % des habitants de 65 ans et plus vivent à moins de ${PROCHE_FRAIS_M} m d'un parc, d'un jardin public ou d'un bois d'au moins ${fmt(FRAIS_MIN_HA, 1)} ha.`);
    if (phrases.length) h.push(`<h3>En bref</h3><p>${phrases.join(" ")}</p>`);

    // Actions
    const ac = d.actions || [];
    if (ac.length) {
      const n1 = ac.filter((a) => a.priorite === 1).length;
      h.push(`<h3>Actions proposées</h3>
        <p>${fmt(ac.length)} action${ac.length > 1 ? "s" : ""}, dont ${fmt(n1)} de priorité 1. Elles découlent de règles fixes, appliquées de la même façon à tous les territoires, et sont à confronter à la connaissance du terrain des services.</p>
        <div class="defile haut"><table class="table-actions"><thead><tr><th>Prio.</th><th>Lieu ou public</th><th>Constat</th><th>Proposition</th></tr></thead><tbody>
        ${ac.map((a) => `<tr><td><span class="priorite p${a.priorite}">${a.priorite}</span></td><td>${echappe(a.lieu)}<span class="sous">${a.theme}</span></td><td>${echappe(a.constat)}</td><td>${echappe(a.proposition)}<span class="sous">Partenaires : ${echappe(a.partenaire)}</span></td></tr>`).join("")}
        </tbody></table></div>
        <p class="note">Priorité 1 : public très vulnérable directement exposé, ou plusieurs facteurs cumulés ; 2 : exposition notable ; 3 : amélioration. L'export pour Excel ajoute des colonnes vides pour le coût, l'échéance et le pilote.</p>`);
    }

    // Chaleur et végétation
    h.push("<h3>1. Chaleur de surface et végétation</h3>");
    if (ch) {
      h.push(`<div class="tuiles">
        <div class="tuile"><div class="valeur">${fmt(ch.mediane, 1)} °C</div><div class="libelle">température de surface médiane</div></div>
        <div class="tuile"><div class="valeur">${fmt(ch.p90 - ch.p10, 1)} °C</div><div class="libelle">écart entre secteurs frais et chauds (centiles 10 et 90)</div></div>
        <div class="tuile"><div class="valeur">${fmt(100 * ch.partVegetale)} %</div><div class="libelle">de la surface en végétation dense (NDVI ≥ 0,5)</div></div>
        <div class="tuile"><div class="valeur">${fmt(100 * ch.partMinerale)} %</div><div class="libelle">peu ou pas végétalisée (NDVI &lt; 0,2 : minéral, sol nu, eau)</div></div>
      </div>
      <p>Sur les pixels ${duT}, température et végétation évoluent en sens inverse : un NDVI plus élevé de 0,1 va avec une surface plus fraîche de ${fmt(Math.abs(ch.pente) / 10, 1)} °C en moyenne (corrélation ${fmt(ch.correlation, 2)}).</p>
      <p class="note">Médiane par pixel de ${ch.scenes.length} image${ch.scenes.length > 1 ? "s" : ""} Landsat 8 ou 9 : ${ch.scenes.map((s) => `${s.date.split("-").reverse().join("/")} (${fmt(s.moyenne, 1)} °C en moyenne)`).join(", ")}. Passage du satellite vers ${ch.scenes[0].heure} en temps universel.${ch.partielles ? ` Faute d'images entièrement dégagées, des images en partie nuageuses ont été utilisées : ${fmt(100 * ch.couverture)} % de la commune est couverte.` : ""}</p>`);
    } else h.push(`<p class="note">Température de surface indisponible : ${echappe(d.erreurs.chaleur || "raison inconnue")}.</p>`);

    // Populations
    h.push("<h3>2. Populations fragiles face à la chaleur</h3>");
    if (ca) {
      const t = ca.tot, part = (a, b) => b > 0 ? fmt(100 * a / b) + " %" : "n. d.";
      h.push(`<table><thead><tr><th></th><th class="n">${G ? "Territoire" : "Commune"}</th>${ch ? '<th class="n">dont cinquième le plus chaud</th><th class="n">Part exposée</th>' : ""}</tr></thead><tbody>
        <tr><td>Habitants</td><td class="n">${fmt(t.ind)}</td>${ch ? `<td class="n">${fmt(t.indChaud)}</td><td class="n">${part(t.indChaud, t.ind)}</td>` : ""}</tr>
        <tr><td>65 ans ou plus</td><td class="n">${fmt(t.ages)}</td>${ch ? `<td class="n">${fmt(t.agesChaud)}</td><td class="n">${part(t.agesChaud, t.ages)}</td>` : ""}</tr>
        <tr><td>Moins de 6 ans</td><td class="n">${fmt(t.jeunes)}</td>${ch ? `<td class="n">${fmt(t.jeunesChaud)}</td><td class="n">${part(t.jeunesChaud, t.jeunes)}</td>` : ""}</tr>
        <tr><td>Ménages pauvres</td><td class="n">${fmt(t.pauv)}</td>${ch ? `<td class="n">${fmt(t.pauvChaud)}</td><td class="n">${part(t.pauvChaud, t.pauv)}</td>` : ""}</tr>
      </tbody></table>
      <p class="note">${fmt(t.nb)} carreaux habités de 200 m (INSEE, Filosofi 2019), dont ${fmt(t.estimes)} aux valeurs estimées par l'INSEE pour protéger le secret statistique. ${G ? "Dans le territoire" : "Dans la commune"}, ${part(t.pauv, t.men)} des ménages sont sous le seuil de pauvreté et ${part(t.ages80, t.ind)} des habitants ont 80 ans ou plus.${ch ? ` Un carreau est compté dans le cinquième le plus chaud quand sa température de surface moyenne atteint ${fmt(ch.seuilChaud, 1)} °C, seuil dépassé par 20 % de la surface ${adjT} (${fmt(t.nbChauds)} carreaux).` : ""}</p>`);
    } else h.push('<p class="note">Aucun carreau de population disponible pour ce territoire (données INSEE limitées à l\'Hexagone, à la Martinique et à La Réunion).</p>');

    if (G && ca) {
      const lignes = d.commune.membres.map((m) => {
        const cs = ca.cellules.filter((c) => c.code === m.code), ss = (d.sites || []).filter((s) => s.code === m.code);
        const ind = cs.reduce((a, c) => a + c.ind, 0);
        const avecT = cs.filter((c) => isFinite(c.lst)), indT = avecT.reduce((a, c) => a + c.ind, 0);
        return {
          nom: m.nom, ind, sites: ss.length, sitesChauds: ss.filter((s) => s.chaud).length,
          ecart: ch && indT > 0 ? avecT.reduce((a, c) => a + c.ind * c.lst, 0) / indT - ch.mediane : NaN,
          partChaud: ind > 0 ? cs.reduce((a, c) => a + (c.chaud ? c.ind : 0), 0) / ind : NaN,
          pauv: cs.reduce((a, c) => a + c.pauv, 0) / (cs.reduce((a, c) => a + c.men, 0) || NaN),
        };
      }).sort((a, b) => (isFinite(b.ecart) ? b.ecart : -1e9) - (isFinite(a.ecart) ? a.ecart : -1e9));
      d.parCommune = lignes;
      h.push(`<p><b>Par commune</b></p><div class="defile"><table><thead><tr><th>Commune</th><th class="n">Habitants</th><th class="n">Ménages pauvres</th>${ch ? '<th class="n">Écart de surface</th><th class="n">Habitants en secteur chaud</th>' : ""}<th class="n">Lieux sensibles${ch ? " (en secteur chaud)" : ""}</th></tr></thead><tbody>
        ${lignes.map((l) => `<tr><td>${echappe(l.nom)}</td><td class="n">${fmt(l.ind)}</td><td class="n">${fmt(100 * l.pauv)} %</td>${ch ? `<td class="n">${signe(l.ecart)} °C</td><td class="n">${fmt(100 * l.partChaud)} %</td>` : ""}<td class="n">${fmt(l.sites)}${ch ? ` (${fmt(l.sitesChauds)})` : ""}</td></tr>`).join("")}
        </tbody></table></div>
        ${ch ? '<p class="note">Écart de surface : moyenne des carreaux de la commune pondérée par leurs habitants, comparée à la médiane du territoire. Secteur chaud : le cinquième le plus chaud du territoire.</p>' : ""}`);
    }

    // Lieux sensibles
    h.push("<h3>3. Lieux sensibles</h3>");
    if (d.sites && d.sites.length) {
      const parType = Object.keys(TYPES).map((k) => { const l = d.sites.filter((s) => s.type === k); return `${fmt(l.length)} ${TYPES[k].pluriel}${ch ? ` (${fmt(l.filter((s) => s.chaud).length)} dans le cinquième le plus chaud)` : ""}`; });
      h.push(`<p>${parType.join(" ; ")}.</p>
        ${d.sites.length > 40 ? `<p class="note">${ch ? "Les 40 plus chauds" : "40 premiers"} sur ${fmt(d.sites.length)} ; liste complète dans l'export « Lieux sensibles ».</p>` : ""}        <div class="defile"><table><thead><tr><th>Lieu</th><th>Type</th><th class="n">Capacité</th>${ch ? '<th class="n">Écart de surface</th><th class="n">NDVI</th>' : ""}</tr></thead><tbody>
        ${d.sites.slice(0, 40).map((s) => `<tr><td>${echappe(s.nom)}${s.chaud ? ' <span class="etiquette chaud">secteur chaud</span>' : ""}</td><td>${TYPES[s.type].nom}</td><td class="n">${s.capacite ? fmt(s.capacite) : ""}</td>${ch ? `<td class="n">${signe(s.lst - ch.mediane)} °C</td><td class="n">${fmt(s.ndvi, 2)}</td>` : ""}</tr>`).join("")}
        </tbody></table></div>
        <p class="note">Base permanente des équipements 2025 (INSEE). Écart et NDVI calculés dans un rayon de ${RAYON_SITE_M} m autour du point, par rapport à la médiane ${adjT}.</p>`);
    } else h.push('<p class="note">Aucune école, crèche ou hébergement pour personnes âgées localisé dans ce territoire.</p>');

    // Lieux de fraîcheur
    h.push("<h3>4. Lieux de fraîcheur</h3>");
    if (fr) {
      const part = (a, b) => b > 0 ? fmt(100 * a / b) + " %" : "n. d.";
      const mesures = fr.lieux.filter((l) => isFinite(l.ecart)), frais = fr.lieux.filter((l) => l.frais);
      h.push(`<div class="tuiles">
        <div class="tuile"><div class="valeur">${fmt(fr.lieux.length)}</div><div class="libelle">parcs, jardins publics et bois d'au moins ${fmt(FRAIS_MIN_HA, 1)} ha${ch ? `, dont ${fmt(frais.length)} plus frais que la médiane d'au moins ${fmt(-ECART_FRAIS)} °C` : ""}</div></div>
        ${ca ? `<div class="tuile"><div class="valeur">${part(fr.proches.ind, ca.tot.ind)}</div><div class="libelle">des habitants à moins de ${PROCHE_FRAIS_M} m de l'un d'eux</div></div>
        <div class="tuile"><div class="valeur">${part(fr.proches.ages, ca.tot.ages)}</div><div class="libelle">des 65 ans et plus</div></div>
        <div class="tuile"><div class="valeur">${part(fr.proches.jeunes, ca.tot.jeunes)}</div><div class="libelle">des moins de 6 ans</div></div>` : ""}
      </div>`);
      if (d.sites && d.sites.length) {
        const loin = Object.keys(TYPES).map((k) => { const l = d.sites.filter((s) => s.type === k); return l.length ? `${fmt(l.filter((s) => s.distFrais > PROCHE_FRAIS_M).length)} ${TYPES[k].pluriel.split(" (")[0]} sur ${fmt(l.length)}` : null; }).filter(Boolean);
        h.push(`<p>À plus de ${PROCHE_FRAIS_M} m de tout lieu de fraîcheur : ${loin.join(" ; ")}.</p>`);
      }
      const LISTE_MAX = 40;
      if (fr.lieux.length) h.push(`${fr.lieux.length > LISTE_MAX ? `<p class="note">Les ${LISTE_MAX} plus grands sur ${fmt(fr.lieux.length)} ; liste complète dans l'export « Lieux de fraîcheur ».</p>` : ""}<div class="defile"><table><thead><tr><th>Lieu</th><th>Type</th><th class="n">Surface</th>${ch ? '<th class="n">Écart de surface</th><th class="n">NDVI</th>' : ""}</tr></thead><tbody>
        ${fr.lieux.slice(0, LISTE_MAX).map((l) => `<tr><td>${echappe(l.nom || "sans nom")}${l.frais ? ' <span class="etiquette frais">fraîcheur mesurée</span>' : ""}</td><td>${l.type === "bois" ? "Bois" : "Parc ou jardin"}</td><td class="n">${fmt(l.surface / 10000, 1)} ha</td>${ch ? `<td class="n">${signe(l.ecart)} °C</td><td class="n">${fmt(l.ndvi, 2)}</td>` : ""}</tr>`).join("")}
        </tbody></table></div>`);
      h.push(`<p class="note">Parcs, jardins publics et bois cartographiés dans OpenStreetMap${fr.enregistre ? ` (relevé enregistré${fr.date ? " le " + fr.date.split("-").reverse().join("/") : ""})` : ""}, y compris ceux situés à moins de ${MARGE_FRAIS_M} m au-delà de la limite ${adjT}, qui comptent pour la proximité mais ne figurent pas dans la liste. Distances à vol d'oiseau depuis le centre de chaque carreau de 200 m ou depuis le lieu sensible. Les horaires d'ouverture, l'accès réel et les cimetières ne sont pas pris en compte.${ch ? " L'écart de surface est la moyenne des pixels Landsat du lieu, comparée à la médiane " + adjT + " ; il n'est pas calculé pour les lieux de moins de quatre pixels." : ""}</p>`);
    } else h.push(`<p class="note">Lieux de fraîcheur indisponibles : ${echappe(d.erreurs.frais || "raison inconnue")}.</p>`);

    // Risques
    h.push("<h3>5. Risques connus</h3>");
    const r = d.risques;
    if (r) {
      h.push(`<ul class="liste-risques">${r.familles.map((f) => `<li>${echappe(f)}</li>`).join("") || "<li>Aucun risque recensé</li>"}</ul>`);
      if (r.precisions.length) h.push(`<p class="note">Précisions : ${r.precisions.map((x) => echappe(x.charAt(0).toLowerCase() + x.slice(1))).join(" ; ")}.</p>`);
      if (r.catnatTotal != null) h.push(`<p>${fmt(r.catnatTotal)} arrêté${r.catnatTotal > 1 ? "s" : ""} de catastrophe naturelle depuis 1982${G ? ", cumulés sur les " + r.nbCommunes + " communes (un même épisode compte une fois par commune touchée)" : ""}${r.catnat.length ? " : " + r.catnat.map((c) => `${echappe(c.libelle.toLowerCase())} (${c.nb}, dernier épisode en ${c.dernier})`).join(" ; ") : ""}.</p>`);
      const divers = [];
      if (r.tri.length) divers.push(`territoire à risque important d'inondation : ${r.tri.map(echappe).join(", ")}`);
      const niveaux = { 1: "très faible", 2: "faible", 3: "modérée", 4: "moyenne", 5: "forte" };
      if (r.seisme) divers.push(`zone de sismicité ${echappe(r.seisme)} sur 5${niveaux[r.seisme] ? " (" + niveaux[r.seisme] + ")" : ""}`);
      if (r.radon) divers.push(`potentiel radon de catégorie ${echappe(r.radon)} sur 3`);
      if (divers.length) h.push(`<p class="note">${divers.join(" ; ").replace(/^./, (c) => c.toUpperCase())}.</p>`);
    } else h.push('<p class="note">Le service Géorisques n\'a pas répondu.</p>');

    // Climat futur
    h.push("<h3>6. Climat futur</h3>");
    if (d.climat) {
      h.push(`<div class="tridents">${d.climat.slice(0, 3).map(trident).join("")}</div>
        <div class="defile"><table><thead><tr><th>Indicateur</th><th class="n">Référence</th><th class="n">2030</th><th class="n">2050</th><th class="n">2100</th></tr></thead><tbody>
        ${d.climat.map((l) => `<tr><td>${echappe(l.libelle)}</td><td class="n">${fmt(l.ref, l.ref % 1 ? 1 : 0)}</td>${l.h.map((x) => x.med == null ? '<td class="n">n. d.</td>' : `<td class="n">${fmt(x.med, x.med % 1 ? 1 : 0)}<span class="fourchette">${fmt(x.bas, x.bas % 1 ? 1 : 0)} à ${fmt(x.haut, x.haut % 1 ? 1 : 0)}</span></td>`).join("")}</tr>`).join("")}
        </tbody></table></div>
        <p class="note">Climadiag Commune, Météo-France (version du 9 septembre 2026). Référence : climat de 1976 à 2005. Les horizons 2030, 2050 et 2100 suivent la trajectoire de réchauffement de référence pour l'adaptation (+2 °C, +2,7 °C et +4 °C en France). Sous la valeur médiane, la fourchette des simulations.</p>`);
    } else h.push('<p class="note">Pas de projection Climadiag pour ce territoire.</p>');

    h.push(`<h3>Méthode et limites</h3>
      <p class="note">La température de surface n'est pas la température de l'air : c'est celle des toits, des chaussées et des feuillages vus par le satellite, en fin de matinée. Elle désigne bien les secteurs qui emmagasinent la chaleur, mais ne mesure pas l'îlot de chaleur nocturne. La bande thermique de Landsat a une finesse réelle de 100 m, fournie rééchantillonnée à 30 m.</p>
      <p class="note">La priorité d'un carreau est la moyenne de trois rangs calculés dans le territoire étudié : température de surface, nombre de personnes de moins de 6 ans ou de 65 ans et plus, part de ménages pauvres. Elle classe les carreaux du territoire étudié entre eux et ne se compare pas d'un territoire à l'autre.</p>
      <p class="note">Les populations datent de 2019, les équipements de 2025, les images des cinq derniers étés. Les contours sont ceux des communes actuelles.</p>`);
    $("#fiche-contenu").innerHTML = h.join("");

    $("#imprimer").onclick = () => window.print();
    const cellule = (v) => { const s = String(v == null ? "" : v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    if ($("#csv-actions")) $("#csv-actions").onclick = () => telecharger(`actions_${p.code}.csv`,
      [["priorite", "theme", "lieu_ou_public", "constat", "proposition", "partenaires", "longitude", "latitude", "cout_estime", "echeance", "pilote", "etat_avancement"]]
        .concat(d.actions.map((a) => [a.priorite, a.theme, a.lieu, a.constat, a.proposition, a.partenaire, nombre(a.lon, 5), nombre(a.lat, 5), "", "", "", ""].map(cellule))));
    if ($("#csv-frais")) $("#csv-frais").onclick = () => telecharger(`lieux_fraicheur_${p.code}.csv`,
      [["commune", "nom", "type", "surface_ha", "ecart_mediane_c", "ndvi", "fraicheur_mesuree", "longitude", "latitude"]]
        .concat(d.frais.lieux.map((l) => [l.code, l.nom, l.type === "bois" ? "Bois" : "Parc ou jardin", nombre(l.surface / 10000, 2), nombre(l.ecart, 2), nombre(l.ndvi, 3), l.frais ? 1 : 0, nombre(l.lon, 5), nombre(l.lat, 5)].map(cellule))));
    if ($("#csv-carreaux")) $("#csv-carreaux").onclick = () => telecharger(`carreaux_${p.code}.csv`,
      [["commune", "nord_m", "est_m", "epsg", "valeurs_estimees", "habitants", "menages", "menages_pauvres", "moins_6_ans", "65_ans_et_plus", "80_ans_et_plus", "temp_surface_c", "ecart_mediane_c", "ndvi", "cinquieme_chaud", "priorite", "distance_lieu_fraicheur_m"]]
        .concat(ca.cellules.map((c) => [c.code, c.n, c.e, ca.epsg, c.estime ? 1 : 0, nombre(c.ind), nombre(c.men), nombre(c.pauv), nombre(c.jeunes), nombre(c.ages), nombre(c.ages80), nombre(c.lst, 2), ch ? nombre(c.lst - ch.mediane, 2) : "", nombre(c.ndvi, 3), c.chaud ? 1 : 0, nombre(c.score, 0), isFinite(c.distFrais) ? Math.round(c.distFrais) : ""])));
    if ($("#csv-sites")) $("#csv-sites").onclick = () => telecharger(`lieux_sensibles_${p.code}.csv`,
      [["commune", "nom", "type", "capacite", "longitude", "latitude", "temp_surface_c", "ecart_mediane_c", "ndvi", "cinquieme_chaud", "distance_lieu_fraicheur_m"]]
        .concat(d.sites.map((s) => [s.code, '"' + s.nom.replace(/"/g, '""') + '"', TYPES[s.type].nom, s.capacite || "", s.lon, s.lat, nombre(s.lst, 2), ch ? nombre(s.lst - ch.mediane, 2) : "", nombre(s.ndvi, 3), s.chaud ? 1 : 0, isFinite(s.distFrais) ? Math.round(s.distFrais) : ""])));
  }

  // ---------- Territoire étudié : une commune, ou un groupement vu comme un seul territoire ----------
  async function chargerTerritoire(cle) {
    const champs = "fields=nom,code,population,surface,departement&format=geojson&geometry=contour";
    if (!cle.startsWith("g")) {
      const commune = await json(`${GEO}/communes/${cle}?${champs}`);
      commune.properties.codes = [commune.properties.code];
      return commune;
    }
    const t = (await pTerritoires).find((x) => x.code === cle.slice(1));
    if (!t) throw new Error("groupement inconnu");
    const recues = (await enParallele(t.communes, 8, (c) => json(`${GEO}/communes/${c}?${champs}`).catch(() => null))).filter(Boolean);
    if (!recues.length) throw new Error("aucun contour reçu");
    const membres = recues.map((f) => ({ code: f.properties.code, nom: f.properties.nom, geometry: f.geometry, bbox: emprise(f.geometry) }))
      .sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
    return {
      type: "Feature", membres,
      geometry: { type: "MultiPolygon", coordinates: recues.flatMap((f) => polygones(f.geometry)) },
      properties: {
        nom: t.nom, code: t.code, codes: membres.map((m) => m.code),
        population: recues.reduce((s, f) => s + (f.properties.population || 0), 0),
        surface: recues.reduce((s, f) => s + (f.properties.surface || 0), 0),
        groupe: { nb: membres.length, noms: membres.map((m) => m.nom), manquantes: t.communes.length - recues.length },
      },
    };
  }

  // ---------- Enchaînement ----------
  let numero = 0;
  async function lancer(code) {
    const moi = ++numero;
    const perime = () => moi !== numero;
    etapes.clear();
    $("#accueil").hidden = true; $("#resultat").hidden = false;
    $("#fiche-contenu").innerHTML = ""; $("#legende").innerHTML = "";
    preparerCarte(); viderCarte(); carte.invalidateSize();
    const d = courant = { code, erreurs: {} };
    window.__diagnostic = d;
    try {
      const groupe = code.startsWith("g");
      etape("commune", groupe ? "Contours des communes du groupement…" : "Contour de la commune…");
      let commune;
      try {
        commune = await chargerTerritoire(code);
      } catch (e) { etape("commune", (groupe ? "Groupement introuvable" : "Commune introuvable") + " (code " + code.replace("g", "") + ").", "ko"); d.termine = true; return; }
      if (perime()) return;
      commune.bbox = emprise(commune.geometry);
      d.commune = commune;
      champ.value = commune.properties.nom;
      document.title = commune.properties.nom + " · Diagnostic de vulnérabilité climatique";
      etape("commune", groupe ? `Contours des ${commune.membres.length} communes du groupement` : "Contour de la commune", "ok");
      couches.contour = L.geoJSON(commune, { pane: "contour", interactive: false, style: { color: "#14213d", weight: groupe ? 1.6 : 2.5, fill: false } }).addTo(carte);
      carte.fitBounds(couches.contour.getBounds(), { padding: [12, 12] });

      const codes = commune.properties.codes;
      const deps = [...new Set(codes.map((c) => (c.startsWith("97") ? c.slice(0, 3) : c.slice(0, 2))))];
      const outreMer = codes[0].startsWith("97") || codes[0].startsWith("98");

      // Risques et climat ne dépendent pas des images : on les lance en parallèle.
      etape("risques", "Risques connus (Géorisques)…");
      const pRisques = chargerRisques(codes).then((r) => { d.risques = r; if (!perime()) etape("risques", r ? "Risques connus (Géorisques)" : "Géorisques n'a pas répondu", r ? "ok" : "ko"); });
      etape("climat", "Projections climatiques (Météo-France)…");
      const pClimat = chargerClimat(commune.properties.code, deps[0], groupe).catch(() => null).then((c) => { d.climat = c; if (!perime()) etape("climat", c ? "Projections climatiques (Météo-France)" : "Pas de projection pour ce territoire", c ? "ok" : "ko"); });
      etape("frais", "Parcs, jardins publics et bois (OpenStreetMap)…");
      const pFrais = chargerFraicheur(code, commune).catch((e) => { d.erreurs.frais = e.message; return null; });

      try {
        d.chaleur = await calculerChaleur(commune, outreMer);
        if (perime()) return;
        etape("sat", `Température de surface et végétation (${d.chaleur.scenes.length} image${d.chaleur.scenes.length > 1 ? "s" : ""} Landsat)`, "ok");
        Object.assign(couches, calques(d.chaleur, commune.bbox));
      } catch (e) {
        if (perime()) return;
        console.error(e);
        d.erreurs.chaleur = e.message; d.chaleur = null;
        etape("sat", "Température de surface indisponible : " + e.message, "ko");
      }

      etape("pop", "Carreaux de population (INSEE)…");
      d.carreaux = await chargerCarreaux(commune, deps, d.chaleur).catch((e) => { console.error(e); return null; });
      if (perime()) return;
      etape("pop", d.carreaux ? `Carreaux de population (${fmt(d.carreaux.tot.nb)} carreaux)` : "Pas de carreaux de population pour ce territoire", d.carreaux ? "ok" : "ko");
      if (d.carreaux && d.chaleur) couches.carreaux = coucheCarreaux(d);

      etape("sites", "Lieux sensibles (INSEE)…");
      d.sites = await chargerSites(commune, deps, d.chaleur).catch((e) => { console.error(e); return null; });
      if (perime()) return;
      etape("sites", d.sites ? `Lieux sensibles (${fmt(d.sites.length)})` : "Lieux sensibles indisponibles", d.sites ? "ok" : "ko");
      if (d.sites) couches.sites = coucheSites(d);

      const osm = await pFrais;
      if (perime()) return;
      try { d.frais = osm ? analyserFraicheur(osm, d) : null; } catch (e) { console.error(e); d.frais = null; d.erreurs.frais = e.message; }
      etape("frais", d.frais ? `Lieux de fraîcheur (${fmt(d.frais.lieux.length)} parcs, jardins publics et bois${d.frais.enregistre ? ", relevé enregistré" : ""})` : "Lieux de fraîcheur indisponibles : " + (d.erreurs.frais || "raison inconnue"), d.frais ? "ok" : "ko");
      if (d.frais) couches.frais = coucheFraicheur(d);

      await Promise.all([pRisques, pClimat]);
      if (perime()) return;
      d.actions = proposerActions(d);
      majAffichage();
      rediger(d);
      d.termine = true;
    } catch (e) {
      console.error(e);
      if (!perime()) { etape("erreur", "Le diagnostic s'est interrompu : " + e.message, "ko"); d.termine = true; d.erreurs.fatale = e.message; }
    }
  }

  // À l'impression, la carte change de taille : on la recadre sur le territoire étudié.
  function recadrer() {
    if (!carte || !couches.contour) return;
    carte.invalidateSize();
    carte.fitBounds(couches.contour.getBounds(), { padding: [8, 8], animate: false });
  }
  window.addEventListener("beforeprint", recadrer);
  window.addEventListener("afterprint", () => setTimeout(recadrer, 50));
  window.__recadrer = recadrer;

  depuisAdresse();
})();
