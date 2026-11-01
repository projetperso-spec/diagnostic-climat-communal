# Relevés enregistrés des lieux de fraîcheur (parcs, jardins publics, bois) pour les territoires d'exemple.
# Le site les lit dans docs/data/fraicheur/<code>.json ; pour les autres territoires, il interroge
# OpenStreetMap en direct avec la même requête (voir requeteFraicheur dans docs/app.js).
# Usage : Rscript R/05_fraicheur.R 93066 g200058782
suppressPackageStartupMessages({ library(jsonlite); library(curl) })

args <- commandArgs(trailingOnly = TRUE)
codes <- if (length(args)) args else c("g200058782", "93066", "g200057867", "94017", "78551", "78190", "92024")
MARGE_M <- 400   # même marge que MARGE_FRAIS_M dans docs/app.js
SERVEURS <- c("https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter")
GARDER <- c("name", "leisure", "landuse", "natural", "access", "garden:type")
dir.create("docs/data/fraicheur", showWarnings = FALSE, recursive = TRUE)
territoires <- fromJSON("docs/data/territoires.json", simplifyVector = FALSE)

lire <- function(url) {
  h <- new_handle(useragent = "diagnostic-climat-communal (projet de Cesarion Djonel)")
  fromJSON(rawToChar(curl_fetch_memory(url, handle = h)$content), simplifyVector = FALSE)
}
# Emprise d'une commune : coordonnées du contour, aplaties (longitude, latitude, longitude...).
emprise_commune <- function(code) {
  g <- lire(sprintf("https://geo.api.gouv.fr/communes/%s?format=geojson&geometry=contour", code))
  v <- unlist(g$geometry$coordinates)
  c(min(v[c(TRUE, FALSE)]), min(v[c(FALSE, TRUE)]), max(v[c(TRUE, FALSE)]), max(v[c(FALSE, TRUE)]))
}
overpass <- function(requete) {
  for (essai in 1:3) for (s in SERVEURS) {
    h <- new_handle(useragent = "diagnostic-climat-communal (projet de Cesarion Djonel)", timeout = 200)
    handle_setopt(h, postfields = paste0("data=", curl_escape(requete)))
    r <- tryCatch(curl_fetch_memory(s, handle = h), error = function(e) NULL)
    if (!is.null(r) && r$status_code == 200) return(fromJSON(rawToChar(r$content), simplifyVector = FALSE))
    message("   ", s, " : ", if (is.null(r)) "sans réponse" else r$status_code)
    Sys.sleep(10 * essai)
  }
  stop("OpenStreetMap n'a pas répondu")
}
arrondir <- function(pts) lapply(pts, function(p) list(lat = round(p$lat, 6), lon = round(p$lon, 6)))

for (code in codes) {
  if (startsWith(code, "g")) {
    t <- Filter(function(x) x$code == substring(code, 2), territoires)[[1]]
    e <- sapply(unlist(t$communes), emprise_commune)
    b <- c(min(e[1, ]), min(e[2, ]), max(e[3, ]), max(e[4, ]))
    nom <- t$nom
  } else { b <- emprise_commune(code); nom <- code }
  dlat <- MARGE_M / 111320; dlon <- MARGE_M / (111320 * cos(mean(b[c(2, 4)]) * pi / 180))
  bb <- sprintf("%.5f,%.5f,%.5f,%.5f", b[2] - dlat, b[1] - dlon, b[4] + dlat, b[3] + dlon)
  message(code, " ", nom, " (", bb, ")")
  requete <- paste0('[out:json][timeout:180][bbox:', bb, '];(',
    'way["leisure"~"^(park|garden|nature_reserve)$"];way["landuse"="forest"];way["natural"="wood"];',
    'relation["leisure"~"^(park|garden|nature_reserve)$"];relation["landuse"="forest"];relation["natural"="wood"];);out geom;')
  osm <- overpass(requete)
  elements <- lapply(osm$elements, function(el) {
    x <- list(type = el$type, tags = el$tags[intersect(names(el$tags), GARDER)])
    if (el$type == "way") x$geometry <- arrondir(el$geometry)
    else x$members <- lapply(Filter(function(m) !is.null(m$geometry), el$members), function(m) list(role = m$role, geometry = arrondir(m$geometry)))
    x
  })
  sortie <- sprintf("docs/data/fraicheur/%s.json", code)
  write(toJSON(list(date = format(Sys.Date()), source = "contributeurs OpenStreetMap (ODbL)", elements = elements), auto_unbox = TRUE, digits = NA), sortie)
  message("   ", length(elements), " objets, ", round(file.size(sortie) / 1e6, 1), " Mo")
  Sys.sleep(5)
}
