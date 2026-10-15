# Projections climatiques par commune : données « Climadiag Commune » de Météo-France
# (version 4.1.1 du 9 septembre 2026, entrepôt meteofrance-drias sur data.gouv.fr).
# Chaque commune a une valeur de référence et, pour 2030, 2050 et 2100, une valeur
# basse, médiane et haute. On regroupe les communes par département en JSON compact.
library(data.table)
library(jsonlite)

archive <- "data-brut/climadiag_v411.tar"
tmp <- "data-brut/climadiag"
racine <- file.path(tmp, "CLIMADIAG_COMMUNE", "v411")
sortie <- "docs/data/climat"
dir.create(sortie, recursive = TRUE, showWarnings = FALSE)

if (!dir.exists(file.path(racine, "indicateurs_par_commune"))) {
  untar(archive, exdir = tmp)
}

# Libellés officiels des indicateurs, lus dans la documentation fournie avec les données.
odt <- file.path(racine, "documentation_Indicateurs_ClimadiagCommune.odt")
contenu <- unzip(odt, "content.xml", exdir = tempdir())
xml <- readChar(contenu, file.size(contenu), useBytes = TRUE)
Encoding(xml) <- "UTF-8"
txt <- gsub("<[^>]+>", "", gsub("</text:(p|h)>", "\n", xml))
txt <- gsub("&gt;", ">", gsub("&lt;", "<", gsub("&amp;", "&", txt)))
lignes <- trimws(strsplit(txt, "\n")[[1]])
lignes <- lignes[lignes != "" & lignes != "X"]
i <- grep("^(G|R|S|AG|T)[0-9]+$", lignes)
libelles <- as.list(setNames(lignes[i + 1], lignes[i]))
write_json(libelles, file.path(sortie, "libelles.json"), auto_unbox = TRUE, pretty = TRUE)
cat(length(libelles), "libellés d'indicateurs\n")

fichiers <- list.files(file.path(racine, "indicateurs_par_commune"), pattern = "[.]csv$", full.names = TRUE)
cat(length(fichiers), "communes\n")
# Les fichiers d'outre-mer ont deux colonnes de plus (saison et mois) : fill = TRUE.
d <- rbindlist(lapply(fichiers, fread, encoding = "UTF-8",
                      colClasses = list(character = c("identifiant_insee", "label"))),
               fill = TRUE)
d[, dep := ifelse(substr(identifiant_insee, 1, 2) == "97", substr(identifiant_insee, 1, 3),
                  substr(identifiant_insee, 1, 2))]
d[is.na(label), label := ""]

# Une commune = { "S1": { "": [ref, b30, m30, h30, b50, m50, h50, b00, m00, h00] }, "G1": { "été": [...] } }
# Le JSON est assemblé en texte, colonne par colonne : 35 000 communes en quelques secondes.
large <- dcast(d, dep + identifiant_insee + indicateur_id + label ~ horizon,
               value.var = c("low", "median", "high"))
large <- merge(large, d[, .(ref = ref[1]), by = .(identifiant_insee, indicateur_id, label)],
               by = c("identifiant_insee", "indicateur_id", "label"))
# Presque tout est numérique ; quelques indicateurs agricoles sont des dates (« 27/02 »), gardées en texte.
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
setorder(large, dep, identifiant_insee, indicateur_id, label)
ind <- large[, .(txt = paste0(cle(indicateur_id[1]), ":{", paste0(cle(label), ":", valeurs, collapse = ","), "}")),
             by = .(dep, identifiant_insee, indicateur_id)]
com <- ind[, .(txt = paste0(cle(identifiant_insee[1]), ":{", paste(txt, collapse = ","), "}")),
           by = .(dep, identifiant_insee)]
for (dp in unique(com$dep)) {
  con <- file(file.path(sortie, paste0(dp, ".json")), open = "wb", encoding = "UTF-8")
  writeLines(enc2utf8(paste0("{", paste(com[dep == dp, txt], collapse = ",\n"), "}")), con, useBytes = TRUE)
  close(con)
}
cat(uniqueN(d$dep), "départements écrits dans", sortie, "\n")
