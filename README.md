
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
└── INSTALLER_VIEWER_COMPLET.ps1      One-shot installer (prerequisites + build)
```

## Prerequisites

- **Windows 10/11**
- **[Node.js](https://nodejs.org) ≥ 18** (npm included)
- **PostgreSQL** — see the installation section below
- **[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)** (only for client sharing): `winget install Cloudflare.cloudflared`

## Installation

### Recommended: one-shot installer

From the repository root, in PowerShell:

```powershell
git clone <URL_OF_THIS_REPO>
cd MAGO-Viewer
powershell -NoProfile -ExecutionPolicy Bypass -File .\INSTALLER_VIEWER_COMPLET.ps1
```

The installer (it re-elevates to administrator on its own) installs Node.js LTS, PostgreSQL 16 and cloudflared through `winget` if they are missing, starts PostgreSQL, creates the two empty databases (`mago_enrichment`, `mago_access`), loads the clean schema, generates a local `.env` with a random JWT secret, builds the viewer and adds a desktop shortcut. During the PostgreSQL setup window, choose and **remember the `postgres` password** — the installer asks for it again right after to create the databases. It finishes by checking the API on `http://localhost:3001/api/health`.

Then launch via the **MAGO Viewer** desktop shortcut (or `LANCER_MAGO_VIEWER.ps1`): PostgreSQL, the API (port 3001) and the viewer start, and the browser opens. See [`INSTALLATION_PUBLIQUE.md`](INSTALLATION_PUBLIQUE.md) for exactly what the installer creates.

### Advanced: portable PostgreSQL

Instead of a system install you can run PostgreSQL from the Windows x64 **binaries zip** ([enterprisedb.com](https://www.enterprisedb.com/download-postgresql-binaries)) extracted to `C:\PGSQL\pgsql\`, initialized with:

```powershell
& "C:\PGSQL\pgsql\bin\initdb.exe" -D "C:\PGSQL\pgdata" -U postgres -W -E UTF8
```

The launcher and the `*_BDD.ps1` scripts auto-detect **either** a `postgresql*` Windows service **or** this portable `C:\PGSQL` layout. Database and client-access details are in `MAGO_Viewer_CLIENT_BDD_ACCES/INSTALL_BDD_ACCES_CLIENT.txt` (French — the `psql` commands are copy-pasteable as-is). To migrate data between machines: `SAUVEGARDER_BDD.ps1` then `RESTAURER_BDD.ps1`.

## Sharing a scene with a client

`LANCER_TUNNEL_PUBLIC_MAGO.ps1` opens a public Cloudflare tunnel and generates an access link. See `README_acces_client.md` and `README_vue_client_v2.md` for client account management (credentials, expiry).

## Database backup

`SAUVEGARDER_BDD.ps1` exports the database; `RESTAURER_BDD.ps1` re-imports it on another machine.

## Detailed documentation

The `README_*.md` and `README_PATCH_*.txt` files document each feature (client view, navigation, splat alignment, public tunnel…). They are written in French.

## License

MIT — see [`LICENSE`](LICENSE). Free to use, including commercially.

### Commercial use

The MIT License permits commercial use. If you use MAGO in a commercial context,
the authors kindly ask that you notify Quarta at **contact@quarta.fr**.
This is a courtesy request, not a condition of the licence.

---
*Tools originally developed at Quarta, a French land-surveying company.*
