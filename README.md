# The Travellers — Suivi de Tournois de Backgammon

Application web pour organiser les tournois de backgammon du club **The Travellers**
(Paris) : inscriptions, tirage au sort, saisie des scores depuis n'importe quel
téléphone, et affichage public des tableaux en direct.

- **Hébergement : Vercel** (site statique + fonction serverless).
- **Base de données : cloud partagé** (Vercel KV / Redis Upstash) — tout le monde voit
  les mêmes données en temps réel. Les joueurs n'ont **aucun réglage** à faire : il
  leur suffit d'ouvrir le lien.

## Format du tournoi

Le nombre de joueurs est **libre** (32, 48, 49, 64…).

1. **Phase 1** — tout le monde joue un match (paires tirées au sort). Avec un nombre
   impair de joueurs, un joueur est exempt et qualifié d'office.
2. **Tableau final** — élimination directe. Sa taille est la **puissance de 2** juste
   au-dessus du nombre de qualifiés ; les places manquantes vont **aussitôt aux premiers
   perdants** de la phase 1 (*repêchage*), dans l'ordre où leur match s'est terminé
   (heure de la première saisie du score : une correction ne fait pas perdre sa place).
   Un repêché n'est jamais placé face à celui qui vient de le battre (la place revient
   alors au perdant suivant).
   Un match se joue **dès que ses deux adversaires sont connus** — personne n'attend
   la fin de la phase 1.
3. **Consolante** — les perdants non repêchés, en élimination directe, remplie **au fil
   de l'eau** : les deux premiers arrivés jouent ensemble aussitôt, puis les deux
   suivants… ; les derniers arrivés reçoivent les exempts (directement au 2e tour, où
   un vainqueur les attend déjà).

| Joueurs | Phase 1 | Tableau final | Repêchés | Consolante |
|---|---|---|---|---|
| 48 | 24 matchs | 32 | 8 | 16 |
| 49 | 24 matchs + 1 exempt | 32 | 7 | 17 |
| 60 | 30 matchs | 32 | 2 | 28 |
| 64 | 32 matchs | 32 | — | 32 |

## Utilisation le jour J

1. **Joueurs** : coller la liste des inscrits (un nom par ligne), vérifier l'aperçu
   de la structure, puis **Tirage au sort**.
2. **Tableau** : à afficher sur l'écran de la salle — plein écran, les deux arbres
   (principal et consolante) alternent toutes les 20 s et avancent à chaque résultat.
3. **Scores** : à chaque fin de match, le résultat se saisit en deux gestes
   (liste « À jouer maintenant »). Une fenêtre indique aussitôt à chacun quoi faire :
   jouer tout de suite contre tel joueur, attendre un adversaire, repêché, direction
   la consolante, ou éliminé.
4. **Réglages** : points par phase et par tour, consolante, rotation de l'affichage,
   règlement, corrections de score (avec avertissement si des matchs suivants sont
   impactés), nouveau tirage.

## Architecture

```
index.html          Coquille de l'application
assets/style.css    Charte graphique (crème / encre / or)
icons/              Logo « TC » (favicon, écran d’accueil, en-tête)
js/store.js         Moteur de tournoi (état recalculé à partir du tirage et des scores)
js/cloud.js         Synchro cloud temps réel (file d'envoi persistée, hors-ligne toléré)
js/app.js           Routeur SPA + vues (arbres plein écran, saisie, réglages)
api/store.js        Fonction serverless : base de données Redis (Vercel KV)
vercel.json         Configuration Vercel (en-têtes de cache)
```

**Fiabilité de la saisie simultanée.** La structure d'un tournoi (joueurs, réglages,
tirage) et ses scores sont stockés séparément : **un enregistrement par match**. Deux
résultats saisis au même moment sur deux téléphones ne peuvent donc jamais s'écraser.
Tout l'état du tournoi (qui joue contre qui, repêchés, consolante, champion) est
recalculé de façon déterministe à partir du tirage et des scores ; un score devenu
obsolète (correction en amont, nouveau tirage) est simplement ignoré. Un score saisi
sans réseau est mis en file et envoyé dès le retour de la connexion.

### Redis

| Clé | Contenu |
|---|---|
| `tg:ids` | ensemble des identifiants de tournois |
| `tg:t:<id>` | structure d'un tournoi (JSON, sans les scores) |
| `tg:s:<id>` | hash `matchId → score` |
| `tg:rev` | compteur incrémenté à chaque écriture (rafraîchissement temps réel) |

### API interne (`/api/store`)

| Méthode | Corps / Query | Effet |
|---|---|---|
| `GET` | `?meta=1` | `{ configured, rev }` (sondage léger) |
| `GET` | `?health=1` | `{ configured, ok, redisMs, build, error? }` — diagnostic à ouvrir dans un navigateur (aucun secret) |
| `GET` | — | `{ configured, rev, tournaments }` (structures + scores) |
| `POST` | `{ op:"upsert", tournament }` | crée / met à jour la structure |
| `POST` | `{ op:"delete", id }` | supprime un tournoi et ses scores |
| `POST` | `{ op:"score", tid, matchId, record }` | enregistre un score |
| `POST` | `{ op:"unscore", tid, matchId }` | efface un score |
| `POST` | `{ op:"resetScores", tid, keepDraw }` | purge les scores d'un ancien tirage |
| `POST` | `{ op:"replaceAll", tournaments }` | remplace toute la base |

### Base de données endormie (offre gratuite Upstash)

Une base Upstash gratuite qui ne reçoit aucune requête pendant ~14 jours est
**archivée** : son adresse disparaît et l'app affiche « Base de données
introuvable ». Pour l'éviter, `vercel.json` déclare une tâche planifiée
quotidienne (`crons`) qui interroge `/api/store` une fois par jour.

Si c'est déjà arrivé : Vercel → projet → **Storage** → créer une base
**Upstash for Redis** (gratuite) → **Connect** au projet → **Redeploy**.
Si Vercel signale que les variables existent déjà, mettre un préfixe
(ex. `TG`) : la fonction essaie toutes les bases déclarées et garde celle
qui répond. Les tournois restés sur les appareils sont renvoyés tout seuls
dans la nouvelle base.

## Déploiement sur Vercel

1. [vercel.com](https://vercel.com) → **Add New… → Project** → importer le dépôt,
   Framework Preset **Other** (aucun build).
2. Onglet **Storage** → **Create Database** → **Upstash for Redis** → **Connect** au
   projet (laisser le préfixe vide), puis **Redeploy**.
3. La pastille en haut à droite passe de **« Local »** à **« Cloud »**.

La production est déployée depuis la branche `main`.

> Variables reconnues : `KV_REST_API_URL` / `KV_REST_API_TOKEN` (Vercel KV) ou
> `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`, ou toute paire préfixée
> `*_REST_*_URL` / `*_REST_*_TOKEN` (le jeton en lecture seule est ignoré).

## Développement local

```bash
python3 -m http.server 8080      # mode local (sans cloud)
# ou, avec les fonctions serverless :
npm i -g vercel && vercel dev
```
