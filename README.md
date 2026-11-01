# Diagnostic de vulnérabilité climatique communal

**Auteur : Césarion Djonel** (2026).

On tape le nom d'une commune, le site sort une carte et une fiche qui croisent :

1. la **chaleur de surface** et la **végétation**, calculées à la demande sur des images Landsat 8 et 9 ;
2. les **populations fragiles** : moins de 6 ans, 65 ans et plus, ménages pauvres, au carreau de 200 m (INSEE, Filosofi 2019) ;
3. les **lieux sensibles** : écoles, crèches, hébergements pour personnes âgées (INSEE, Base permanente des équipements 2025) ;
4. les **lieux de fraîcheur** : parcs, jardins publics et bois (OpenStreetMap), leur température mesurée par le satellite et la part des habitants qui en vivent à moins de 300 m ;
5. les **risques connus** (Géorisques) ;
6. le **climat futur** (Météo-France, Climadiag Commune, issu des projections DRIAS).

La fiche commence par une **liste d'actions priorisées** (cours d'école, hébergements pour personnes âgées, secteurs habités prioritaires, registre canicule, lieux frais de proximité, inondation, sécheresse), exportable pour Excel avec des colonnes à remplir : coût, échéance, pilote, état d'avancement.

Le site fonctionne pour toute commune de l'Hexagone et de Corse, et pour 1 242 groupements de communes (intercommunalités, territoires du Grand Paris comme Plaine Commune), traités comme un seul territoire avec un tableau comparatif par commune. Outre-mer, il est partiel (voir « Limites »).

## Ouvrir le site

Double-cliquer sur `ouvrir-le-site.bat`, ou lancer un serveur de fichiers dans `docs/` :

```
cd docs
python -m http.server 8765
```

puis ouvrir http://127.0.0.1:8765. L'adresse garde le territoire : `http://127.0.0.1:8765/#93066` ouvre Saint-Denis, `#g200057867` ouvre Plaine Commune, `#g200058782` Saint-Quentin-en-Yvelines. En ligne, l'adresse https://projetperso-spec.github.io/diagnostic-climat-communal/saint-quentin-en-yvelines/ ouvre directement Saint-Quentin-en-Yvelines.

Le site est fait de fichiers statiques : il se publie tel quel en déposant le dossier `docs/` chez un hébergeur de pages (environ 170 Mo, dont 166 Mo de données).

## Comment ça marche

Il n'y a pas de serveur de calcul. Le navigateur fait tout au moment de la demande :

| Étape | Source interrogée | Ce qui est calculé |
|---|---|---|
| Contour | API Découpage administratif (geo.api.gouv.fr) | emprise et masque de la commune |
| Chaleur, végétation | Landsat Collection 2 niveau 2, lu par morceaux sur Microsoft Planetary Computer | médiane par pixel de 5 images d'été peu nuageuses des cinq dernières années ; écart à la médiane communale ; NDVI |
| Populations | `docs/data/carreaux/<département>.csv` | température et NDVI moyens de chaque carreau, part des habitants dans le cinquième le plus chaud, score de priorité |
| Lieux sensibles | `docs/data/equipements/<département>.tsv` | température et NDVI dans un rayon de 100 m |
| Lieux de fraîcheur | OpenStreetMap (relevé enregistré dans `docs/data/fraicheur/` pour les territoires d'exemple, sinon requête en direct) | surface, température de surface moyenne de chaque lieu, distance au plus proche depuis chaque carreau et chaque lieu sensible |
| Actions | règles fixes en tête de `proposerActions` dans `docs/app.js` | liste priorisée de 1 à 3, avec partenaires |
| Risques | API Géorisques v1 | risques recensés, arrêtés de catastrophe naturelle, sismicité, radon |
| Climat futur | `docs/data/climat/<département>.json` | valeurs de référence et horizons 2030, 2050, 2100 |

Le **score de priorité** d'un carreau est la moyenne de trois rangs calculés dans la commune : température de surface, nombre de personnes de moins de 6 ans ou de 65 ans et plus, part de ménages pauvres. Il classe les carreaux d'une même commune entre eux ; il ne se compare pas d'une commune à l'autre.

## Refaire les fichiers de données

Les scripts R découpent trois fichiers nationaux par département, et le quatrième (`R/04_territoires.R`) tire de l'archive Climadiag la liste des groupements et leurs projections. Placer dans `data-brut/` :

| Fichier | Où le trouver |
|---|---|
| `carreaux_200m_met.csv`, `carreaux_200m_mart.csv`, `carreaux_200m_reun.csv` | INSEE, « Revenus, pauvreté et niveau de vie en 2019, données carroyées », archive `Filosofi2019_carreaux_200m_csv.zip` |
| `BPE25.parquet` | INSEE, « Équipements géolocalisés en 2025 » |
| `climadiag_v411.tar` | Météo-France, entrepôt `meteofrance-drias` sur data.gouv.fr, dossier `CLIMADIAG_COMMUNE`, fichier `donnees_climadiag_commune_v411_20260909.tar` |

puis, depuis la racine du projet :

```
Rscript run_all.R
```

Les relevés des lieux de fraîcheur se refont à part : `Rscript R/05_fraicheur.R` (territoires d'exemple) ou `Rscript R/05_fraicheur.R 78646 g200058782` (codes choisis ; préfixe `g` pour un groupement). Les serveurs publics d'OpenStreetMap sont souvent saturés : le script réessaie.

Paquets R : `data.table`, `arrow`, `dplyr`, `jsonlite`, `curl`. Compter environ dix minutes, surtout pour décompresser les 35 000 fichiers Climadiag.

## Limites

- La température de surface n'est pas la température de l'air. Elle est mesurée vers 10 h 40 en temps universel, donc en fin de matinée : elle montre les secteurs qui emmagasinent la chaleur, pas l'îlot de chaleur nocturne.
- La bande thermique de Landsat a une finesse réelle de 100 m, livrée rééchantillonnée à 30 m.
- Les secteurs les plus chauds sont souvent des zones d'activité ou des emprises ferroviaires, peu habitées. La fiche donne donc deux lectures : la part des habitants dans le cinquième le plus chaud du territoire, et le classement des carreaux habités entre eux.
- Lieux de fraîcheur : un parc, un jardin public ou un bois d'au moins 0,5 ha cartographié dans OpenStreetMap ; un lieu est dit « plus frais » quand sa surface est inférieure d'au moins 1 °C à la médiane du territoire. Les horaires d'ouverture, l'accès réel, les cimetières, les cours d'école et les salles rafraîchies ne sont pas pris en compte ; les distances sont à vol d'oiseau, depuis le centre des carreaux de 200 m. Hors relevé enregistré, la requête en direct dépend de serveurs publics souvent saturés.
- Actions : elles découlent de règles fixes, identiques pour tous les territoires ; elles signalent où regarder et doivent être confrontées à la connaissance du terrain. Les coûts ne sont pas estimés.
- Populations de 2019, équipements de 2025, images des cinq derniers étés : les dates ne coïncident pas.
- Dans les carreaux trop peu peuplés, l'INSEE publie des valeurs estimées pour protéger le secret statistique ; la fiche en donne le nombre.
- Outre-mer : la température de surface Landsat n'est pas produite sur La Réunion (vérifié sur Saint-Denis de La Réunion) ; les carreaux INSEE n'existent que pour la Martinique et La Réunion.
- Groupements : la composition vient des métadonnées Climadiag (version du 9 septembre 2026). La Métropole du Grand Paris entière n'est pas proposée, seuls ses territoires le sont. Les arrêtés de catastrophe naturelle sont cumulés par commune : un même épisode compte une fois par commune touchée. Un groupement trop étendu pour tenir dans une seule image Landsat n'a pas de carte de chaleur.

## Vérifications faites

Diagnostic lancé de bout en bout dans Chrome sur Saint-Denis (93066), Champigny-sur-Marne, Croissy-sur-Seine, Aubervilliers, Paris, Marseille, Ajaccio, Florac Trois Rivières, Fort-de-France et Saint-Denis de La Réunion, ainsi que sur deux groupements : Plaine Commune (8 communes, 7 secondes) et la Métropole de Lyon (58 communes, 19 secondes). Durée : 3 à 15 secondes selon la taille de la commune. La surface de Saint-Denis recalculée sur la grille des pixels (1 578 ha) recoupe la surface officielle (1 577 ha).

Lieux de fraîcheur et actions vérifiés dans Chrome le 1er novembre 2026 sur Clichy (requête en direct), Saint-Denis et Saint-Quentin-en-Yvelines (relevés enregistrés, 5 et 9 secondes) ; impression en PDF vérifiée sur Clichy (8 pages) et Saint-Quentin-en-Yvelines (12 pages).

Il n'y a pas de tests automatisés.

## Licences des données

Landsat : domaine public (USGS). OpenStreetMap : ODbL. INSEE, Géorisques, Météo-France, API Découpage administratif, IGN : Licence Ouverte Etalab 2.0. Bibliothèques embarquées dans `docs/vendor/` : Leaflet (BSD-2), geotiff.js (MIT), proj4js (MIT).
