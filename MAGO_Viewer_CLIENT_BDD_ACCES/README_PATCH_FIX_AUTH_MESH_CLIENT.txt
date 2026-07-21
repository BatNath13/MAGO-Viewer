PATCH FIX AUTH + MESH CLIENT
============================

Objectif :
- Le lien client affiche toujours l'écran de connexion à l'ouverture.
- Un ancien jeton sessionStorage ne permet plus d'entrer sans retaper le mot de passe.
- Le bouton "Créer vue client" publie le mesh dans storage/models/<model_id>/ avant de créer l'accès.
- L'API refuse maintenant de créer un accès client si scene.json ou client_scene_mesh.glb est absent.
  Cela évite les liens qui ouvrent une grille vide.

Après application :
1) Rebuild viewer.
2) Typecheck API.
3) Relancer MAGO Viewer avec l'icône bureau.
4) Recréer l'accès client depuis Export > Créer vue client.
   Important : les accès créés avant ce patch peuvent encore pointer vers un modèle sans scène publiée.
