PATCH_NAVIGATION_CLOUDCOMPARE

But : remplacer le zoom libre type FPS par une navigation orbitale stable type CloudCompare.

Modifications :
- molette = zoom orbital autour du pivot camera.target ;
- la molette ne deplace plus le pivot, donc plus de rotation/derive selon le point de vue ;
- double-clic dans la scene = place le pivot de rotation sur le point clique ;
- double-clic dans le vide = replace le pivot au centre de la scene chargee ;
- aucune limite dure de zoom, radius min tres bas ;
- slider Vitesse zoom conserve ;
- correction du texte des menus deroulants : suppression du caractere fleche qui s'affichait en "a--"/"â–¼".

Installation :
cd "C:\MAGO_Viewer\MAGO_Viewer_CLIENT_BDD_ACCES"
Expand-Archive "$env:USERPROFILE\Downloads\PATCH_NAVIGATION_CLOUDCOMPARE.zip" -DestinationPath "." -Force
powershell -ExecutionPolicy Bypass -File ".\patch_navigation_cloudcompare\INSTALLER_PATCH_NAVIGATION_CLOUDCOMPARE.ps1"
npm run build
