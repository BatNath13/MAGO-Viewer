
> Clean Windows installation without private data: see [INSTALLATION_PUBLIQUE.md](INSTALLATION_PUBLIQUE.md).

**🇬🇧 English** | [🇫🇷 Français](README.fr.md)

# MAGO Viewer

**Hybrid web viewer for enriched 3D meshes and Gaussian Splatting, with semantic enrichment and link-based sharing.**

MAGO Viewer displays 3D scenes in the browser combining multi-LOD meshes (tiled GLB format, as produced by MAGO Pipeline) and Gaussian Splatting clouds. It lets you navigate, measure, enrich each scene object with semantic attributes stored in a database, and share a scene with an external client via a password-protected link.

Built with Babylon.js, Vite and TypeScript on the browser side, and a Fastify + PostgreSQL API on the server side. French/English interface selector.

## Features

- Display of multi-LOD GLB meshes and Gaussian splats
- CloudCompare-style navigation, measurement tools
- Per-object semantic enrichment (attributes stored in PostgreSQL)
- Gaussian Splatting editing and alignment
- "Client view" mode: scene sharing via a public link + credentials, with expiry date
- Database backup / restore

## Architecture

```
├── MAGO_Viewer_CLIENT_BDD_ACCES/     Main application
│   ├── src/                          Babylon.js frontend (TypeScript, incl. i18n.ts)
│   ├── index.html / vite.config.ts
│   ├── api/mago-enrichment-api/      REST API (Fastify + PostgreSQL)
│   │   ├── src/  sql/  scripts/
│   │   └── .env.example              → copy to .env and fill in
│   ├── launcher/                     Executable launcher (PyInstaller)
│   ├── LANCER_MAGO_VIEWER.ps1        Startup (PostgreSQL + API + viewer)
│   ├── LANCER_TUNNEL_PUBLIC_MAGO.ps1 Client sharing via Cloudflare tunnel
│   ├── SAUVEGARDER_BDD.ps1 / RESTAURER_BDD.ps1
│   └── README_*.md                   Per-feature documentation (French)
├── launcher/                         Launcher sources
└── INSTALLER_VIEWER_COMPLET.ps1      Post-clone installation
```

## Prerequisites

- **Windows 10/11**
- **[Node.js](https://nodejs.org) ≥ 18** (npm included)
- **PostgreSQL** — see the installation section below
- **[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)** (only for client sharing): `winget install Cloudflare.cloudflared`

## Installation

### 1. Get the code and dependencies

```bash
git clone <URL_OF_THIS_REPO>
cd mago-viewer/MAGO_Viewer_CLIENT_BDD_ACCES

npm install                    # frontend
cd api/mago-enrichment-api
npm install                    # API
```

### 2. Install and initialize PostgreSQL

Download the PostgreSQL 16 Windows x64 **binaries zip** ([enterprisedb.com](https://www.enterprisedb.com/download-postgresql-binaries)), then extract so that you get `C:\PGSQL\pgsql\`.

> The launcher expects PostgreSQL in `C:\PGSQL`. To use another location, adjust the `PG_BIN` / `PG_DATA` paths at the top of `launcher/mago_launch.py` and of the `*_BDD.ps1` scripts.

Initialize the database:

```powershell
& "C:\PGSQL\pgsql\bin\initdb.exe" -D "C:\PGSQL\pgdata" -U postgres -W -E UTF8
```

Creating the enrichment database and configuring client access are described in `MAGO_Viewer_CLIENT_BDD_ACCES/INSTALL_BDD_ACCES_CLIENT.txt` (French — the `psql` commands are copy-pasteable as-is). To migrate data from an existing machine: `SAUVEGARDER_BDD.ps1` on the old machine then `RESTAURER_BDD.ps1` on the new one.

### 3. Configure secrets

```powershell
cd MAGO_Viewer_CLIENT_BDD_ACCES\api\mago-enrichment-api
copy .env.example .env
notepad .env      # set the PostgreSQL password and a JWT secret
```

`REGENERER_SECRET_JWT.ps1` generates a random JWT secret.

### 4. Build and launch

```powershell
cd ..\..\..
powershell -ExecutionPolicy Bypass -File INSTALLER_VIEWER_COMPLET.ps1
```

Then double-click the **MAGO Viewer** desktop icon (or `LANCER_MAGO_VIEWER.ps1`): the launcher starts PostgreSQL, the API (port 3001) and the viewer, and opens the browser.

## Sharing a scene with a client

`LANCER_TUNNEL_PUBLIC_MAGO.ps1` opens a public Cloudflare tunnel and generates an access link. See `README_acces_client.md` and `README_vue_client_v2.md` for client account management (credentials, expiry).

## Database backup

`SAUVEGARDER_BDD.ps1` exports the database; `RESTAURER_BDD.ps1` re-imports it on another machine.

## Detailed documentation

The `README_*.md` and `README_PATCH_*.txt` files document each feature (client view, navigation, splat alignment, public tunnel…). They are written in French.

## License

MIT — see [`LICENSE`](LICENSE). Free to use, including commercially.

---
*Tools originally developed at Quarta, a French land-surveying company.*
