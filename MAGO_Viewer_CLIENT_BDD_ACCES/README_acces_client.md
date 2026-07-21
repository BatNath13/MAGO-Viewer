# MAGO Viewer — Accès client géré dans PostgreSQL

Objectif demandé : gérer les abonnements directement dans une **base PostgreSQL**, avec une ligne par client contenant :

| Colonne | Rôle |
|---|---|
| `lien_client` | Lien à envoyer au client |
| `identifiant` | Login du client |
| `mot_de_passe` | Mot de passe à communiquer au client |
| `date_expiration` | Date + heure + minute de fin d'abonnement |
| `active` | `false` coupe l'accès immédiatement |
| `model_id` | Scène / modèle lié au client |

Le client ouvre le lien, se connecte avec `identifiant` + `mot_de_passe`, et voit uniquement sa scène.

---

## 1. Mise en place

Depuis le dossier API :

```powershell
cd "C:\MAGO_Viewer\MAGO_Viewer_CLIENT_BDD_ACCES\api\mago-enrichment-api"
npm install
```

Créer/copier `.env` depuis `.env.example`, puis remplir au minimum :

```env
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=ton_mot_de_passe_postgres
PGDATABASE=mago_enrichment
PORT=3001
CLIENT_PUBLIC_BASE_URL=http://localhost:3001
JWT_SECRET=un_secret_long
CLIENT_EXPIRY_TIMEZONE=Europe/Paris
CLIENT_AUTH_REQUIRED=false
STORAGE_DIR=./storage
```

Générer le secret :

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Créer / mettre à jour la table :

```powershell
psql "postgresql://postgres:TON_MDP@localhost:5432/mago_enrichment" -f sql/001_client_access.sql
```

Ou via npm si tu utilises `DATABASE_URL` :

```powershell
$env:DATABASE_URL="postgresql://postgres:TON_MDP@localhost:5432/mago_enrichment"
npm run migrate
```

---

## 2. Table à modifier dans pgAdmin

Table principale :

```sql
client_access
```

Vue confortable en lecture :

```sql
client_access_admin
```

Dans pgAdmin, tu peux modifier directement :

- `lien_client`
- `identifiant`
- `mot_de_passe`
- `date_expiration`
- `active`

Pour prolonger ou raccourcir un abonnement, modifie uniquement `date_expiration`.

Exemple SQL :

```sql
SET TIME ZONE 'Europe/Paris';

UPDATE client_access
SET date_expiration = '2026-08-30 18:45'::timestamptz
WHERE identifiant = 'dupont';
```

À **18:45**, l'accès est refusé automatiquement.

Pour couper tout de suite :

```sql
UPDATE client_access
SET active = false
WHERE identifiant = 'dupont';
```

Pour réactiver :

```sql
UPDATE client_access
SET active = true
WHERE identifiant = 'dupont';
```

---

## 3. Créer une scène / modèle

```powershell
npm run admin -- register-model --name "Salle C10"
```

La commande affiche un `id`, par exemple :

```text
id=3
```

Dépose ensuite les fichiers dans :

```text
api/mago-enrichment-api/storage/models/3/
```

Puis ajuste :

```text
api/mago-enrichment-api/storage/models/3/scene.json
```

Exemple :

```json
{
  "name": "Salle C10",
  "mesh": "modele.glb",
  "splat": null
}
```

---

## 4. Créer une ligne client dans la base

Tu peux le faire par commande :

```powershell
npm run admin -- create --user dupont --pass "MotDePasse#2026" --model 3 --expires "2026-08-30 18:45"
```

Cela crée une ligne dans `client_access` avec :

```text
lien_client     = http://localhost:3001/?client=1&m=3
identifiant     = dupont
mot_de_passe    = MotDePasse#2026
date_expiration = 2026-08-30 18:45
model_id        = 3
active          = true
```

Tu peux ensuite modifier la date directement dans pgAdmin.

---

## 5. Modifier l'expiration

### Option A — directement dans pgAdmin

Dans la table `client_access`, change la valeur de :

```text
date_expiration
```

Format conseillé :

```text
2026-08-30 18:45:00+02
```

Ou via SQL :

```sql
SET TIME ZONE 'Europe/Paris';
UPDATE client_access
SET date_expiration = '2026-08-30 18:45'::timestamptz
WHERE identifiant = 'dupont';
```

### Option B — par commande

```powershell
npm run admin -- expire --user dupont --expires "2026-10-31 12:30"
```

---

## 6. Lancer l'API

```powershell
npm start
```

Puis ouvre :

```text
http://localhost:3001/?client=1&m=3
```

---

## 7. Important sécurité

Cette version stocke `mot_de_passe` en clair dans PostgreSQL parce que tu as demandé à pouvoir voir/modifier le mot de passe dans la base.

Pour un vrai déploiement public sensible, la version plus propre est de stocker uniquement un hash du mot de passe. Mais pour ton besoin actuel de gestion simple dans pgAdmin, cette version correspond à ce que tu as demandé.
