PATCH_ZOOM_SPLAT_ALIGN_CLEAN

Base : MAGO_Viewer (2)(2).zip fourni par Nathan.

Modifications ciblées :
- retour à la navigation ArcRotate/zoom natif Babylon de cette base ;
- ajout d'un slider "Vitesse zoom" dans le panneau Caméra ;
- le slider règle wheelDeltaPercentage et pinchDeltaPercentage ;
- aucun handler wheel maison, donc le zoom reste actif même quand le picking/alignement par points est activé ;
- piquage des splats plus robuste : données PLY attachées à l'asset, tolérance de clic élargie, scan plus fin ;
- réinitialise main.ts, index.html, sceneSetup.ts, cameraTools.ts depuis la base propre + corrections.

Après installation : npm run build, relance viewer, Ctrl+F5.
