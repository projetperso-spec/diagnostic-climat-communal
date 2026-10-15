# Reconstruit les fichiers par département lus par le site (docs/data).
# À lancer depuis la racine du projet, une fois les fichiers sources placés dans data-brut/.
for (script in c("R/01_carreaux.R", "R/02_equipements.R", "R/03_climat.R", "R/04_territoires.R")) {
  cat("\n==", script, "==\n")
  source(script, encoding = "UTF-8", local = new.env())
}
