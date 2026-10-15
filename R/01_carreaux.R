# Carreaux Filosofi 2019 de 200 m (INSEE) : un fichier allégé par département.
# Le site ne charge que le département de la commune demandée, puis garde les
# carreaux dont le centre tombe dans le contour de la commune.
library(data.table)

brut <- "data-brut"
sortie <- "docs/data/carreaux"
dir.create(sortie, recursive = TRUE, showWarnings = FALSE)

fichiers <- c("carreaux_200m_met.csv", "carreaux_200m_mart.csv", "carreaux_200m_reun.csv")
garder <- c("idcar_200m", "i_est_200", "lcog_geo", "ind", "men", "men_pauv", "ind_snv",
            "ind_0_3", "ind_4_5", "ind_6_10", "ind_65_79", "ind_80p")

index <- list()
for (f in fichiers) {
  d <- fread(file.path(brut, f), select = garder, colClasses = list(character = "lcog_geo"))
  # L'identifiant porte le système de coordonnées et le coin sud-ouest du carreau :
  # CRS3035RES200mN2029800E4252400
  d[, epsg := as.integer(substr(idcar_200m, 4, 7))]
  d[, n := as.integer(gsub("^.*N|E[0-9]+$", "", idcar_200m)) %/% 200L]
  d[, e := as.integer(gsub("^.*E", "", idcar_200m)) %/% 200L]

  # lcog_geo liste la ou les communes du carreau (codes de 5 caractères accolés).
  # Un carreau à cheval sur deux départements est écrit dans les deux fichiers.
  nb <- nchar(d$lcog_geo) %/% 5L
  lignes <- rep(seq_len(nrow(d)), nb)
  rang <- sequence(nb)
  code <- substr(d$lcog_geo[lignes], (rang - 1L) * 5L + 1L, rang * 5L)
  dep <- ifelse(substr(code, 1, 2) == "97", substr(code, 1, 3), substr(code, 1, 2))
  lien <- unique(data.table(ligne = lignes, dep = dep))

  d[, c("idcar_200m", "lcog_geo") := NULL]
  setnames(d, c("i_est_200", "men_pauv", "ind_snv", "ind_0_3", "ind_4_5", "ind_6_10", "ind_65_79", "ind_80p"),
           c("est", "pauv", "snv", "a0_3", "a4_5", "a6_10", "a65_79", "a80"))
  d[, snv := round(snv)]
  setcolorder(d, c("n", "e", "est", "ind", "men", "pauv", "snv", "a0_3", "a4_5", "a6_10", "a65_79", "a80"))

  for (dp in sort(unique(lien$dep))) {
    x <- d[lien[dep == dp, ligne]]
    index[[dp]] <- list(epsg = x$epsg[1], carreaux = nrow(x))
    fwrite(x[, !"epsg"], file.path(sortie, paste0(dp, ".csv")))
  }
  cat(f, ":", nrow(d), "carreaux\n")
}
jsonlite::write_json(index[order(names(index))], file.path(sortie, "index.json"), auto_unbox = TRUE)
cat(length(index), "départements écrits dans", sortie, "\n")
