# Lieux sensibles à la chaleur, tirés de la Base permanente des équipements 2025 (INSEE) :
# écoles du premier degré, crèches, hébergements pour personnes âgées.
# Un fichier par département, séparé par des tabulations (les noms contiennent des virgules).
library(arrow)
library(dplyr)
library(data.table)

sortie <- "docs/data/equipements"
dir.create(sortie, recursive = TRUE, showWarnings = FALSE)

types <- c(C107 = "ecole", C108 = "ecole", C109 = "ecole", D502 = "creche", D401 = "ehpad")

bpe <- open_dataset("data-brut/BPE25.parquet") |>
  filter(TYPEQU %in% names(types)) |>
  select(DEPCOM, DEP, TYPEQU, NOMRS, LONGITUDE, LATITUDE, CAPACITE, QUALITE_XY) |>
  collect() |>
  as.data.table()

cat("Équipements retenus :", nrow(bpe), "\n")
print(bpe[, .N, by = TYPEQU][order(TYPEQU)])
sans_xy <- bpe[is.na(LONGITUDE) | is.na(LATITUDE), .N]
cat("Sans coordonnées (écartés) :", sans_xy, "\n")

bpe <- bpe[!is.na(LONGITUDE) & !is.na(LATITUDE)]
bpe[, type := types[TYPEQU]]
bpe[, nom := gsub("[\t\r\n]+", " ", trimws(NOMRS))]
bpe[, lon := round(LONGITUDE, 5)]
bpe[, lat := round(LATITUDE, 5)]

for (dp in sort(unique(bpe$DEP))) {
  x <- bpe[DEP == dp, .(commune = DEPCOM, type, code = TYPEQU, nom, lon, lat,
                        capacite = CAPACITE, qualite = QUALITE_XY)]
  fwrite(x, file.path(sortie, paste0(dp, ".tsv")), sep = "\t", quote = FALSE, na = "")
}
cat(uniqueN(bpe$DEP), "départements écrits dans", sortie, "\n")
