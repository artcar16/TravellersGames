# The Travellers — Suivi de Tournois de Backgammon

Application web statique (hébergeable sur **GitHub Pages**) pour gérer des
tournois de backgammon à élimination directe au sein du club **The Travellers**.

La **base de données est constituée de fichiers Markdown** (`data/*.md`)
versionnés dans le dépôt GitHub.

## Fonctionnalités

- **Accueil** : liste des tournois, création et suppression.
- **Tournoi** → 4 sous-pages :
  - **Joueurs** : liste, ajout / modification / retrait, statistiques
    (matchs joués, victoires, total de points, différentiel).
  - **Tableau** : visualisation en arbre à élimination directe. Si une
    *poule secondaire / repêchage des perdants* est activée, des flèches
    permettent de changer de vue et un bouton de **rotation automatique**
    (30 s par défaut) fait défiler les tableaux pour l'affichage public.
  - **Saisie des scores** : le joueur sélectionne son nom, voit son match
    en cours (adversaire + nombre de points de la manche), saisit le score,
    puis l'app affiche son match suivant — ou *« patientez »* si l'adversaire
    n'a pas encore terminé.
  - **Réglages** : nombre de joueurs, valeur des manches (ex. manche 1 = 7 pts,
    manche 2 = 9 pts…), règlement, repêchage on/off, poule secondaire on/off,
    rotation automatique, et configuration de la synchronisation GitHub.

## La base de données en `.md` — comment ça marche

GitHub Pages est un hébergement **statique** : une page ne peut pas écrire de
fichier côté serveur. La persistance fonctionne donc en deux temps :

1. **Travail local** — toutes les données sont enregistrées dans le
   `localStorage` du navigateur (fonctionne hors-ligne, sans aucune config).
2. **Synchronisation GitHub** — depuis *Réglages → Base de données*, on
   renseigne `owner`, dépôt, branche et un **Personal Access Token (PAT)**.
   L'application lit et écrit alors les fichiers `data/*.md` directement via
   l'**API GitHub Contents** (le navigateur committe à votre place). Le token
   reste **uniquement** dans le navigateur de l'organisateur ; il n'est jamais
   commité.

> Lecture publique (affichage des tableaux) : aucun token requis si le dépôt
> est public. Écriture (saisie des scores persistée sur GitHub) : token requis.

### Créer le token (fine-grained recommandé)

1. GitHub → *Settings → Developer settings → Personal access tokens →
   Fine-grained tokens*.
2. Donner accès **uniquement à ce dépôt**.
3. Permission **Repository → Contents : Read and write**.
4. Copier le token dans *Réglages → Base de données → Personal Access Token*,
   puis **Tester la connexion** et **Pousser vers GitHub**.

## Déploiement sur GitHub Pages

1. Pousser ce dépôt sur GitHub.
2. *Settings → Pages* → Source : `Deploy from a branch` → branche `main`
   (ou la branche publiée) → dossier `/ (root)`.
3. Ouvrir l'URL `https://<owner>.github.io/<repo>/`.

Le fichier `.nojekyll` désactive le traitement Jekyll afin que le dossier
`data/` soit servi tel quel.

## Structure

```
index.html          Coquille de l'application
assets/style.css    Charte graphique The Travellers (marine / or / crème)
assets/logo.svg     Blason du club
js/store.js         Modèle de données + logique de tournoi (bracket)
js/github.js        Synchronisation API GitHub (lecture/écriture des .md)
js/app.js           Routeur SPA + rendu des vues
data/*.md           Base de données (index + un fichier par tournoi)
```

## Développement local

Servir le dossier avec n'importe quel serveur statique, par ex. :

```bash
python3 -m http.server 8080
# puis http://localhost:8080
```

(L'ouverture directe en `file://` fonctionne aussi, mais la synchro GitHub
nécessite un contexte `http(s)`.)
