# The Travellers — Suivi de Tournois de Backgammon

Application web pour gérer des tournois de backgammon à élimination directe
au sein du club **The Travellers**.

- **Hébergement : Vercel** (site statique + fonctions serverless).
- **Base de données : cloud partagé** (Vercel KV / Redis Upstash) — toutes les
  données sont en ligne et **partagées en temps réel avec tout le monde**.
  Les joueurs n'ont **aucun token ni réglage** à saisir : il leur suffit
  d'ouvrir le lien.

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
  - **Réglages** : nombre de joueurs, valeur des manches, règlement,
    repêchage on/off, poule secondaire on/off, rotation automatique, et
    état de la base de données partagée.

## Comment fonctionne la base de données partagée

L'application est servie en statique, mais Vercel exécute une petite
**fonction serverless** (`api/store.js`) qui parle à un magasin **Redis**
(Vercel KV / Upstash). La **clé secrète reste côté serveur** : contrairement
à l'ancienne approche par token GitHub, plus rien de sensible n'est exposé
dans le navigateur.

- **Lecture / écriture** : l'app appelle `/api/store`. Tous les visiteurs
  partagent la même base.
- **Temps réel** : un compteur de révision est sondé régulièrement ; dès que
  quelqu'un enregistre un score, les autres écrans se rafraîchissent tout
  seuls (idéal pour l'affichage public et la saisie depuis les téléphones).
- **Mode local de secours** : tant que le magasin n'est pas branché (ou hors
  ligne), l'app fonctionne en `localStorage` sur l'appareil courant. Dès que
  le cloud est disponible, les données locales existantes sont **migrées**
  automatiquement vers le cloud.

## Déploiement sur Vercel

### 1. Importer le projet

1. Aller sur [vercel.com](https://vercel.com), **Add New… → Project**.
2. Importer le dépôt GitHub `travellersgames`.
3. Framework Preset : **Other** (aucune commande de build, aucun dossier de
   sortie — c'est un site statique avec un dossier `api/`).
4. **Deploy**. L'app est en ligne (ex. `https://travellersgames.vercel.app`).
   À ce stade elle fonctionne déjà, en **mode local**.

### 2. Activer la base de données partagée (une seule fois)

1. Dans le projet Vercel → onglet **Storage** → **Create Database** →
   **KV** (Redis, *Upstash*) → choisir la région et créer.
2. **Connect** ce magasin au projet. Vercel ajoute automatiquement les
   variables d'environnement nécessaires
   (`KV_REST_API_URL`, `KV_REST_API_TOKEN`, …).
3. **Redeploy** le projet (onglet *Deployments* → *Redeploy*) pour que les
   variables soient prises en compte.

C'est tout. La pastille en haut à droite passe de **« Local »** à
**« Cloud »**, et toutes les données deviennent partagées entre tous les
appareils, en temps réel.

> Variables reconnues : `KV_REST_API_URL` / `KV_REST_API_TOKEN` (Vercel KV)
> **ou** `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (Upstash
> directement). Si l'on préfère créer le magasin sur
> [upstash.com](https://upstash.com), il suffit d'ajouter ces deux variables
> dans *Settings → Environment Variables* du projet Vercel, puis de
> redéployer.

## Structure

```
index.html          Coquille de l'application
assets/style.css    Charte graphique The Travellers (marine / or / crème)
assets/logo.svg     Blason du club
js/store.js         Modèle de données + logique de tournoi (bracket)
js/cloud.js         Synchro cloud partagée (appels à /api/store)
js/app.js           Routeur SPA + rendu des vues
api/store.js        Fonction serverless : base de données Redis (Vercel KV)
vercel.json         Configuration Vercel (routage / en-têtes de cache)
```

## API interne (`/api/store`)

| Méthode | Corps / Query                     | Effet                                   |
|---------|-----------------------------------|-----------------------------------------|
| `GET`   | `?meta=1`                         | `{ configured, rev }` (sondage léger)   |
| `GET`   | —                                 | `{ configured, rev, tournaments }`      |
| `POST`  | `{ op:"upsert", tournament }`     | Crée / met à jour un tournoi            |
| `POST`  | `{ op:"delete", id }`             | Supprime un tournoi                     |
| `POST`  | `{ op:"replaceAll", tournaments }`| Remplace toute la base (migration)      |

Si aucune variable d'environnement n'est configurée, l'API répond
`{ configured:false }` et l'app reste en mode local.

## Développement local

Site statique : on peut le servir avec n'importe quel serveur statique
(les appels `/api/*` renvoient alors 404 → l'app bascule simplement en mode
local) :

```bash
python3 -m http.server 8080
# puis http://localhost:8080
```

Pour tester **aussi les fonctions serverless et le cloud en local**, utiliser
la CLI Vercel :

```bash
npm i -g vercel
vercel dev
# renseigner au besoin KV_REST_API_URL / KV_REST_API_TOKEN dans un .env.local
```
