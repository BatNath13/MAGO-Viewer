
> Clean Windows installation without private data: see [INSTALLATION_PUBLIQUE.md](INSTALLATION_PUBLIQUE.md).

[🇬🇧 English](README.md) | **🇫🇷 Français**

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
└── INSTALLER_VIEWER_COMPLET.ps1      Installeur tout-en-un (prérequis + build)
```

## Prérequis

- **Windows 10/11**
- **[Node.js](https://nodejs.org) ≥ 18** (npm inclus)
- **PostgreSQL** — voir la section installation ci-dessous
- **[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)**
  (uniquement pour le partage client) : `winget install Cloudflare.cloudflared`

## Installation

### Recommandé : l'installeur tout-en-un

Depuis la racine du dépôt, dans PowerShell :

```powershell
git clone <URL_DE_CE_DEPOT>
cd MAGO-Viewer
powershell -NoProfile -ExecutionPolicy Bypass -File .\INSTALLER_VIEWER_COMPLET.ps1
```

L'installeur (il se relance en administrateur tout seul) installe Node.js LTS,
PostgreSQL 16 et cloudflared via `winget` s'ils manquent, démarre PostgreSQL,
crée les deux bases vides (`mago_enrichment`, `mago_access`), charge le schéma
propre, génère un `.env` local avec un secret JWT aléatoire, construit le viewer
et ajoute un raccourci Bureau. Pendant la fenêtre d'installation de PostgreSQL,
choisissez et **retenez le mot de passe `postgres`** : l'installeur le redemande
juste après pour créer les bases. Il termine en testant l'API sur
`http://localhost:3001/api/health`.

Lancez ensuite via le raccourci Bureau **MAGO Viewer** (ou
`LANCER_MAGO_VIEWER.ps1`) : PostgreSQL, l'API (port 3001) et le viewer démarrent,
et le navigateur s'ouvre. Voir [`INSTALLATION_PUBLIQUE.md`](INSTALLATION_PUBLIQUE.md)
pour le détail de ce que crée l'installeur.

### Avancé : PostgreSQL portable

Au lieu d'une installation système, vous pouvez faire tourner PostgreSQL depuis
les binaires zip Windows x64
([enterprisedb.com](https://www.enterprisedb.com/download-postgresql-binaries))
extraits dans `C:\PGSQL\pgsql\`, initialisés avec :

```powershell
& "C:\PGSQL\pgsql\bin\initdb.exe" -D "C:\PGSQL\pgdata" -U postgres -W -E UTF8
```

Le lanceur et les scripts `*_BDD.ps1` détectent automatiquement **soit** un
service Windows `postgresql*`, **soit** cette disposition portable `C:\PGSQL`.
La création de la base d'enrichissement et des accès client est détaillée dans
`MAGO_Viewer_CLIENT_BDD_ACCES/INSTALL_BDD_ACCES_CLIENT.txt`. Pour migrer les
données entre postes : `SAUVEGARDER_BDD.ps1` puis `RESTAURER_BDD.ps1`.

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

### Usage commercial

La licence MIT autorise l'usage commercial. Si vous utilisez MAGO dans un cadre
commercial, merci de bien vouloir en informer Quarta à l'adresse
**contact@quarta.fr**. Il s'agit d'une demande de courtoisie, et non d'une
condition de la licence.

---
*Outils développés à l'origine chez Quarta, société de géomètres-experts.*
