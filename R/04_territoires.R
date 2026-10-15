# Groupements de communes (intercommunalités et territoires du Grand Paris, comme Plaine Commune).
# La composition vient des métadonnées de Climadiag Commune (Météo-France), qui rattachent
# chaque commune à son groupement ; leurs projections climatiques sont dans indicateurs_par_epci.
library(data.table)
library(jsonlite)

racine <- "data-brut/climadiag/CLIMADIAG_COMMUNE/v411"
if (!dir.exists(racine)) untar("data-brut/climadiag_v411.tar", exdir = "data-brut/climadiag")

meta <- fread(file.path(racine, "metadonnees.csv"), encoding = "UTF-8",
              colClasses = list(character = c("identifiant_insee", "identifiant_epci_parent")),
              select = c("identifiant_insee", "nom", "type", "population", "identifiant_epci_parent"))

membres <- meta[type == "commune" & !is.na(identifiant_epci_parent) & identifiant_epci_parent != "",
                .(communes = list(sort(identifiant_insee))), by = .(code = identifiant_epci_parent)]
terr <- merge(meta[type == "epci", .(code = identifiant_insee, nom, population)], membres, by = "code")
# La Métropole du Grand Paris n'a ici que les communes hors territoire : on l'écarte, ses
# territoires (Plaine Commune, Est Ensemble...) sont dans la liste.
terr <- terr[code != "200054781"]
setorder(terr, -population)
cat(nrow(terr), "groupements,", sum(lengths(terr$communes)), "communes rattachées\n")
cat("Plaine Commune :", paste(terr[code == "200057867", communes][[1]], collapse = " "), "\n")

write_json(lapply(seq_len(nrow(terr)), function(i) {
  list(code = terr$code[i], nom = terr$nom[i], population = terr$population[i], communes = terr$communes[[i]])
}), "docs/data/territoires.json", auto_unbox = TRUE)

# Projections des groupements : même format compact que pour les communes (voir 03_climat.R).
fichiers <- file.path(racine, "indicateurs_par_epci", paste0(terr$code, ".csv"))
fichiers <- fichiers[file.exists(fichiers)]
d <- rbindlist(lapply(fichiers, fread, encoding = "UTF-8",
                      colClasses = list(character = c("identifiant_insee", "label"))), fill = TRUE)
d[is.na(label), label := ""]
large <- dcast(d, identifiant_insee + indicateur_id + label ~ horizon, value.var = c("low", "median", "high"))
large <- merge(large, d[, .(ref = ref[1]), by = .(identifiant_insee, indicateur_id, label)],
               by = c("identifiant_insee", "indicateur_id", "label"))
num <- function(x) {
  x <- trimws(as.character(x))
  ifelse(is.na(x) | x == "", "null",
         ifelse(grepl("^-?[0-9]+([.][0-9]+)?$", x), x, paste0('"', x, '"')))
}
col <- function(nom) if (nom %in% names(large)) num(large[[nom]]) else rep("null", nrow(large))
large[, valeurs := paste0("[", num(ref), ",",
                          col("low_2030"), ",", col("median_2030"), ",", col("high_2030"), ",",
                          col("low_2050"), ",", col("median_2050"), ",", col("high_2050"), ",",
                          col("low_2100"), ",", col("median_2100"), ",", col("high_2100"), "]")]
cle <- function(x) paste0('"', gsub('"', "'", x, fixed = TRUE), '"')
setorder(large, identifiant_insee, indicateur_id, label)
ind <- large[, .(txt = paste0(cle(indicateur_id[1]), ":{", paste0(cle(label), ":", valeurs, collapse = ","), "}")),
             by = .(identifiant_insee, indicateur_id)]
com <- ind[, .(txt = paste0(cle(identifiant_insee[1]), ":{", paste(txt, collapse = ","), "}")), by = identifiant_insee]
con <- file("docs/data/climat/groupements.json", open = "wb", encoding = "UTF-8")
writeLines(enc2utf8(paste0("{", paste(com$txt, collapse = ",\n"), "}")), con, useBytes = TRUE)
close(con)
cat(nrow(com), "groupements avec projections\n")
