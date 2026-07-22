# Installation publique propre de MAGO Viewer

Ce correctif rend le dépôt installable sur un PC Windows vierge sans publier les données ayant servi au développement.

## Ce qui est créé localement

- deux bases vides : `mago_enrichment` et `mago_access` ;
- le schéma technique du Viewer ;
- un `.env` local avec un secret JWT aléatoire ;
- les dépendances Node, le build et le raccourci Bureau.

Aucun modèle, attribut métier, compte client, mot de passe, GLB, PLY, splat, nuage ou dump PostgreSQL n’est fourni.

## Installation

Depuis la racine du dépôt :

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\INSTALLER_VIEWER_COMPLET.ps1
```

Le script vérifie Node.js, PostgreSQL et cloudflared, initialise les bases, compile l’application et teste l’API sur `http://localhost:3001/api/health`.

## Fichiers à ne jamais versionner

Le `.gitignore` doit exclure au minimum :

```gitignore
**/.env
**/node_modules/
MAGO_Viewer_CLIENT_BDD_ACCES/api/mago-enrichment-api/storage/
MAGO_Viewer_CLIENT_BDD_ACCES/SAUVEGARDES_BDD/
*.dump
*.log
.client_public_url
```

## Schéma propre

`sql/000_mago_schema.sql` crée uniquement les tables et fonctions nécessaires. Les classes sont ajoutées automatiquement lors de l’import des clés de classes d’une scène. Les tables `model`, `object`, `attribute` et `client_access` sont vides après l’installation.
