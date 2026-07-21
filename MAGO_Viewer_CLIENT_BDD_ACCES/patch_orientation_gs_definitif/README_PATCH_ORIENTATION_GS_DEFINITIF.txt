# PATCH_ORIENTATION_GS_DEFINITIF

Corrige deux causes d'inversion / retournement des Gaussian Splats :

1. Les GS ne reçoivent plus automatiquement la transformation Z-up -> Y-up au chargement.
   Cette conversion reste le défaut pour les meshes MAGO, mais pas pour les splats COLMAP/3DGS.

2. La scène Babylon ne force plus `useRightHandedSystem = true`, qui inversait gauche/droite avec les GS.

Après installation :

```powershell
cd "C:\MAGO_Viewer\MAGO_Viewer_CLIENT_BDD_ACCES"
powershell -ExecutionPolicy Bypass -File ".\patch_orientation_gs_definitif\INSTALLER_PATCH_ORIENTATION_GS.ps1"
npm run build
```

Puis fermer/relancer MAGO Viewer et faire Ctrl+F5.
Recharge ensuite le fichier GS.
