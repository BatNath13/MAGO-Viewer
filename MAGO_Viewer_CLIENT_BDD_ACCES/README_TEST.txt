MAGO VIEWER — CONTOUR DE SELECTION + ATTRIBUTS GLB

Modifications :
- liseré jaune autour de tous les meshes du calque sélectionné ;
- suppression du liseré à la fermeture/désactivation de l'enrichissement ;
- export des attributs PostgreSQL dans node.extras.mago du GLB ;
- restauration automatique des attributs depuis extras lors de la réimportation du GLB ;
- PostgreSQL reste la source utilisée par l'interface.

TEST :
1. Remplacer le dossier du viewer de test par ce dossier, ou l'extraire séparément.
2. Dans PowerShell : npm install puis npm run dev.
3. Démarrer PostgreSQL et l'API comme avant.
4. Charger un GLB, activer Enrichissement, cliquer un calque ou le mesh.
5. Modifier un attribut, exporter en GLB, puis réimporter le GLB exporté.

NOTE : cette archive est la version SOURCE à tester. L'EXE sera reconstruit après validation.
