PATCH_ZOOM_LIBRE_DEFINITIF

Objectif : remplacer le zoom ArcRotateCamera par un déplacement libre dans l'axe de vue.
- La molette ne change plus le radius autour d'une target fixe.
- La caméra avance/recul selon l'endroit où elle regarde.
- Aucune limite de zoom : on peut traverser les objets.
- Le slider Vitesse zoom reste actif avec une plage plus large.

Application :
  powershell -ExecutionPolicy Bypass -File ".\patch_zoom_libre_definitif\INSTALLER_PATCH_ZOOM_LIBRE_DEFINITIF.ps1"
  npm run build
