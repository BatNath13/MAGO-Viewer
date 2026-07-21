PATCH_URL_PUBLIQUE_CLIENT
=========================

Objectif : corriger le bouton "Créer vue client" pour un client hors réseau.

Changements :
- le formulaire "Créer vue client" contient maintenant un champ :
  "Adresse publique à envoyer au client".
- le viewer refuse de créer un accès avec localhost / 127.0.0.1 pour éviter
  d'envoyer un lien inutilisable au client.
- le lien enregistré dans mago_access.public.client_access.lien_client utilise
  l'adresse publique saisie, par exemple :
  https://xxxx.trycloudflare.com/?client=1&m=63
- l'appel API du bouton est relatif (/api/admin/client-access), plus de
  http://localhost:3001 codé en dur côté viewer.
- l'API accepte public_base_url dans POST /api/admin/client-access.

Après dézip du patch :
1) npm run build à la racine du viewer est conseillé.
2) npm run typecheck côté API pour vérification.

Pour le tunnel Cloudflare :
- soit ouvrir une nouvelle fenêtre PowerShell après installation winget,
- soit lancer cloudflared avec son chemin complet si la commande n'est pas encore
  dans le PATH.
