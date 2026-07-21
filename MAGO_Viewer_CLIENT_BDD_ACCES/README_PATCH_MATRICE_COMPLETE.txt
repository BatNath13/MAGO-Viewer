PATCH MAGO Viewer — export matrice complète

Fichier modifié : MAGO Viewer/src/main.ts

Objectif : l'export de matrice CloudCompare / MAGO inclut maintenant :
- la conversion Z-up -> Y-up appliquée par le viewer ;
- les déplacements/rotations/échelles manuels ;
- les transformations au gizmo ;
- l'alignement par points ;
- une matrice calculée/importée mais pas encore appliquée à la source.

Ainsi la matrice exportée correspond à la transformation totale de l'objet source depuis son repère brut RealityScan/CloudCompare vers le repère cible MAGO/CloudCompare.
