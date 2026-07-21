PATCH — Tunnel public automatique depuis « Créer vue client »

Ce patch corrige le fonctionnement attendu :

1) Tu ouvres MAGO Viewer comme avant avec le double-clic bureau.
2) Dans Export > Créer vue client, tu saisis seulement :
   - identifiant
   - mot de passe
   - date/heure d'expiration
3) MAGO démarre automatiquement cloudflared côté API.
4) MAGO récupère automatiquement l'URL https://xxxx.trycloudflare.com.
5) MAGO publie automatiquement le mesh courant dans :
   api/mago-enrichment-api/storage/models/<model_id>/
6) MAGO crée la ligne dans mago_access.public.client_access avec :
   - lien_client public Cloudflare
   - identifiant
   - mot_de_passe
   - date_expiration
   - active
   - model_id

Important : le PC doit rester allumé, MAGO Viewer/API doit rester lancé. Le tunnel Cloudflare lancé automatiquement est enfant du processus API.
Si tu fermes MAGO Viewer/API, le lien Cloudflare ne fonctionne plus.

Installation :

cd "C:\MAGO_Viewer\MAGO_Viewer_CLIENT_BDD_ACCES"

$ZIP = Get-ChildItem "$env:USERPROFILE\Downloads" -Filter "PATCH_TUNNEL_AUTO_BOUTON_CREER_VUE_CLIENT*.zip" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

Expand-Archive $ZIP.FullName -DestinationPath "." -Force

npm run build

cd "C:\MAGO_Viewer\MAGO_Viewer_CLIENT_BDD_ACCES\api\mago-enrichment-api"
npm run typecheck

Ensuite, ferme et relance MAGO Viewer par l'icône bureau.
