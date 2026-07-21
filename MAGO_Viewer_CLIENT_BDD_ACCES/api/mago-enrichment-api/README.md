# MAGO Enrichment API

Backend REST (Fastify + PostgreSQL) pour l'enrichissement sémantique du maillage MAGO.
Sert de pont entre le MAGO Viewer (navigateur) et la base `mago_enrichment`.

## Prérequis
- PostgreSQL en marche, base `mago_enrichment` créée et schéma chargé (`01_mago_schema_seed.sql`).
- Node 18+ (Node 24 OK).

## Installation
```bash
npm install
cp .env.example .env      # puis renseigne PGPASSWORD
```

## Lancement
```bash
npm run dev               # mode watch (redémarre à chaque modif)
# ou
npm start
```
L'API écoute sur http://localhost:3001

## Endpoints

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/health` | Test de vie + heure DB |
| GET | `/api/classes` | Catalogue des classes |
| GET | `/api/models` | Liste des modèles |
| POST | `/api/models` | Créer un modèle `{name, survey_type, description}` |
| DELETE | `/api/models/:id` | Supprimer un modèle |
| POST | `/api/models/:id/import` | Instancier les objets `{classKeys:[...]}` |
| GET | `/api/models/:id/objects` | Objets d'un modèle |
| GET | `/api/models/:id/objects/by-key/:classKey` | Objet + attributs (création paresseuse) |
| GET | `/api/objects/:id/attributes` | Attributs d'un objet |
| POST | `/api/objects/:id/attributes` | Ajouter un attribut |
| PUT | `/api/attributes/:id` | Modifier un attribut |
| DELETE | `/api/attributes/:id` | Supprimer un attribut |

## Note production
En dev, le CORS autorise toutes les origines. Pour un déploiement, restreindre
`origin` (dans `src/server.ts`) à l'origine du viewer.
