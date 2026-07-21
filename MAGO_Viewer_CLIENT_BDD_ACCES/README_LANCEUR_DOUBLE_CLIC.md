# Patch lanceur double-clic MAGO Viewer

Ce patch remet le fonctionnement historique : double-clic sur l'icone MAGO Viewer => demarre PostgreSQL si besoin, demarre l'API MAGO si besoin, puis ouvre http://127.0.0.1:3001/.

Le lanceur est compatible avec la version BDD acces client. Il ne remplace pas la BDD ni le viewer : il ajoute/restaure seulement le dossier `launcher` et les scripts de raccourci.

## Fichiers

- `launcher/mago_launch.py` : lanceur adapte a la version BDD.
- `launcher/MAGO.spec` : spec PyInstaller pour refaire `MAGO.exe`.
- `launcher/MAGO_viewer_icon.ico` et `launcher/mago_logo.png` : icone/logo recuperes de la sauvegarde.
- `INSTALLER_ICONE_MAGO_VIEWER.ps1` : cree le raccourci bureau.
- `RECONSTRUIRE_EXE_MAGO.ps1` : reconstruit `launcher/dist/MAGO.exe` si tu veux un exe comme avant.
