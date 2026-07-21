PATCH MAGO — Bouton « Créer vue client » + base séparée mago_access
==================================================================

Ce patch ajoute :
- un bouton « Créer vue client » dans la section Export du viewer éditeur ;
- une fenêtre avec identifiant, mot de passe, date/heure d'expiration ;
- l'écriture directe dans une base PostgreSQL séparée : mago_access ;
- l'authentification client qui lit dans cette base séparée ;
- la table consultable dans pgAdmin : mago_access > Schemas > public > Tables > client_access.

Après application du patch :
1) mettre ACCESS_PGDATABASE=mago_access dans .env ;
2) créer la base mago_access ;
3) exécuter sql/002_client_access_database.sql dans mago_access ;
4) npm run build côté viewer ;
5) npm run typecheck côté API ;
6) double-cliquer sur l'icône MAGO Viewer comme avant.
