PATCH MAGO — URL publique automatique + publication du mesh client
=================================================================

Ce patch corrige deux points :

1) Le champ « Adresse publique » du bouton « Créer vue client » peut être rempli automatiquement
   depuis un fichier .client_public_url généré par le script LANCER_TUNNEL_PUBLIC_MAGO.ps1.

2) Le bouton « Créer vue client » publie aussi le mesh courant côté serveur dans :
   api/mago-enrichment-api/storage/models/<model_id>/
   avec :
     - client_scene_mesh.glb
     - scene.json

Sans cette publication, le client pouvait se connecter mais voir :
   « Scène indisponible pour ce compte ».

UTILISATION
-----------

1. Appliquer le patch à la racine :
   C:\MAGO_Viewer\MAGO_Viewer_CLIENT_BDD_ACCES

2. Rebuild :
   npm run build
   cd api\mago-enrichment-api
   npm run typecheck

3. Lancer MAGO Viewer par l’icône bureau comme avant.

4. Dans une autre fenêtre PowerShell, lancer :
   powershell -ExecutionPolicy Bypass -File "C:\MAGO_Viewer\MAGO_Viewer_CLIENT_BDD_ACCES\LANCER_TUNNEL_PUBLIC_MAGO.ps1"

5. Garder cette fenêtre ouverte.

6. Dans MAGO Viewer : Export > Créer vue client.
   L'adresse Cloudflare est automatiquement récupérée si le tunnel a bien démarré.

7. Après création, la table mago_access.public.client_access contient :
   lien_client, identifiant, mot_de_passe, date_expiration, active, model_id.
