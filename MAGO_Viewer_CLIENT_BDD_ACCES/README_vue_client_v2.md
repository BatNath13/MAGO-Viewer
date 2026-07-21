# Vue client — 4 modifications

Fichiers modifiés (à copier par-dessus ton arbo, puis `npm run build`) :
`src/scene/clientMode.ts`, `src/scene/clientSession.ts`, `src/main.ts`,
`src/styles/client-mode.css`, `index.html`.

## Ce qui change

1. **Grille et repère XYZ retirés en vue client.** À l'ouverture d'un lien client,
   la grille au sol et les flèches d'axes sont désactivées, et leurs cases (panneau
   Scène) sont masquées pour que le client ne puisse pas les réactiver. En mode
   éditeur, rien ne change.

2. **Nom de la scène choisi à la création.** Le formulaire « Créer vue client » a
   un nouveau champ **« Nom de la scène (visible par le client) »** (pré-rempli avec
   le nom du modèle). Ce nom remplace « client_scene_mesh » dans l'arbre des objets
   côté client. Le fichier stocké reste `client_scene_mesh.glb` (nom interne stable) ;
   seul le nom affiché change.

3. **Barre de chargement au centre** pendant l'ouverture de la vue client :
   - progression réelle pendant le **téléchargement** du maillage (Mo reçus / total, %) ;
   - passage en mode animé « Préparation de l'affichage… » pendant le rendu Babylon ;
   - **disparaît** dès que la scène est prête (ou en cas d'erreur).
   Le client sait ainsi que ça charge et reste patient, même avec un gros mesh.

4. **Plus de « MODE CLIENT · CONSULTATION »** : le sous-titre est vidé en vue client.

## Après application
1. `npm run build` à la racine du viewer.
2. Redémarre MAGO Viewer (icône) et recrée une vue client pour tester le champ nom.
3. Côté client : `Ctrl+Shift+R` la première fois (cache).

## Rappel (non urgent)
La barre de chargement rend l'attente confortable, mais pour un mesh de plusieurs
centaines de Mo via tunnel, penser à publier un GLB **décimé + Draco** reste le vrai
confort. Dis-moi quand tu veux qu'on l'attaque.
