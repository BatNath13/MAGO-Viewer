# MAGO Viewer

**Viewer web hybride pour maillages 3D enrichis et Gaussian Splatting, avec
enrichissement sémantique et partage par lien.**

MAGO Viewer affiche dans le navigateur des scènes 3D combinant maillages
multi-LOD (format GLB tuilé, tel que produit par MAGO Pipeline) et nuages
Gaussian Splatting. Il permet de naviguer, mesurer, enrichir chaque objet de la
scène avec des attributs sémantiques stockés en base, et de partager une scène
avec un client externe via un lien protégé par mot de passe.

Construit avec Babylon.js, Vite et TypeScript côté navigateur, et une API
Fastify + PostgreSQL côté serveur.

## Fonctionnalités

- Affichage de maillages GLB multi-LOD et de splats Gaussian
- Navigation type CloudCompare, outils de mesure
- Enrichissement sémantique par objet (attributs stockés en base PostgreSQL)
- Édition et alignement des nuages Gaussian Splatting
- Mode « vue client » : partage d'une scène par lien public + identifiants,
  avec date d'expiration
- Sauvegarde / restauration de la base de données

## Architecture

```
├── MAGO_Viewer_CLIENT_BDD_ACCES/     Application principale
│   ├── src/                          Frontend Babylon.js (TypeScript)
│   ├── index.html / vite.config.ts
│   ├── api/mago-enrichment-api/      API REST Fastify + PostgreSQL
│   │   ├── src/  sql/  scripts/
│   │   └── .env.example              → à copier en .env et compléter
│   ├── launcher/                     Lanceur exécutable (PyInstaller)
│   ├── LANCER_MAGO_VIEWER.ps1        Démarrage (PostgreSQL + API + viewer)
│   ├── LANCER_TUNNEL_PUBLIC_MAGO.ps1 Partage client via tunnel Cloudflare
│   ├── SAUVEGARDER_BDD.ps1 / RESTAURER_BDD.ps1
│   └── README_*.md                   Documentation par fonctionnalité
├── launcher/                         Sources du lanceur
└── INSTALLER_VIEWER_COMPLET.ps1      Installation après clonage
```

## Prérequis

- **Windows 10/11**
- **[Node.js](https://nodejs.org) ≥ 18** (npm inclus)
- **PostgreSQL** — voir la section installation ci-dessous
- **[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)**
  (uniquement pour le partage client) : `winget install Cloudflare.cloudflared`

## Installation

### 1. Récupérer le code et les dépendances

```bash
git clone <URL_DE_CE_DEPOT>
cd mago-viewer/MAGO_Viewer_CLIENT_BDD_ACCES

npm install                    # frontend
cd api/mago-enrichment-api
npm install                    # API
```

### 2. Installer et initialiser PostgreSQL

Téléchargez les binaires PostgreSQL 16 pour Windows
([enterprisedb.com](https://www.enterprisedb.com/download-postgresql-binaries)),
puis extrayez-les de façon à obtenir `C:\PGSQL\pgsql\`.

> Le lanceur attend PostgreSQL dans `C:\PGSQL`. Pour utiliser un autre
> emplacement, adaptez les chemins `PG_BIN` / `PG_DATA` en tête de
> `launcher/mago_launch.py` et des scripts `*_BDD.ps1`.

Initialisez la base :

```powershell
& "C:\PGSQL\pgsql\bin\initdb.exe" -D "C:\PGSQL\pgdata" -U postgres -W -E UTF8
```

Créez la base d'enrichissement et appliquez les scripts SQL (table des accès
client incluse) — voir `MAGO_Viewer_CLIENT_BDD_ACCES/INSTALL_BDD_ACCES_CLIENT.txt`
pour le détail des commandes `psql`.

### 3. Configurer les secrets

```powershell
cd MAGO_Viewer_CLIENT_BDD_ACCES\api\mago-enrichment-api
copy .env.example .env
notepad .env      # renseigner le mot de passe PostgreSQL et un secret JWT
```

`REGENERER_SECRET_JWT.ps1` génère un secret JWT aléatoire.

### 4. Construire et lancer

```powershell
cd ..\..\..
powershell -ExecutionPolicy Bypass -File INSTALLER_VIEWER_COMPLET.ps1
```

Puis double-clic sur l'icône bureau **MAGO Viewer** (ou
`LANCER_MAGO_VIEWER.ps1`) : le lanceur démarre PostgreSQL, l'API (port 3001) et
le viewer, et ouvre le navigateur.

## Partage d'une scène avec un client

`LANCER_TUNNEL_PUBLIC_MAGO.ps1` ouvre un tunnel Cloudflare public et génère un
lien d'accès. Voir `README_acces_client.md` et `README_vue_client_v2.md` pour
la gestion des comptes clients (identifiants, expiration).

## Sauvegarde de la base

`SAUVEGARDER_BDD.ps1` exporte la base ; `RESTAURER_BDD.ps1` la réimporte sur un
autre poste.

## Documentation détaillée

Les fichiers `README_*.md` et `README_PATCH_*.txt` documentent chaque
fonctionnalité (vue client, navigation, alignement des splats, tunnel public…).

## Licence

MIT — voir [`LICENSE`](LICENSE). Utilisation libre, y compris commerciale.

---
*Outils développés à l'origine chez Quarta, société de géomètres-experts.*
