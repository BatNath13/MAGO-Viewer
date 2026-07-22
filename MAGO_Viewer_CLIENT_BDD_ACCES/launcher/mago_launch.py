# -*- coding: utf-8 -*-
"""MAGO launcher: starts PostgreSQL, the enrichment API, and opens the viewer.

This launcher is intentionally kept compatible with the old desktop double-click
workflow. It discovers the project root from its own location, starts PostgreSQL
only when the 5432 port is not already open, starts the MAGO API only when
/api/health is not already responding, then opens the viewer in the browser.
"""

import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
import tkinter as tk
from tkinter import ttk

CREATE_NO_WINDOW = 0x08000000
STARTED_PROCS = []
STARTED_PG = False
STOP_PGCTL = None
LOG_HANDLES = []


def resource_path(name):
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, name)


def app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def find_project_root():
    """Find the folder containing api/mago-enrichment-api.

    Works when launched from:
    - project/launcher/mago_launch.py
    - project/launcher/dist/MAGO.exe
    - a desktop shortcut whose working directory is the project root
    """
    candidates = []
    here = app_dir()
    cwd = os.getcwd()
    for start in (here, cwd):
        p = os.path.abspath(start)
        for _ in range(8):
            candidates.append(p)
            parent = os.path.dirname(p)
            if parent == p:
                break
            p = parent

    # Common local development fallback, but discovery above is preferred.
    candidates.extend([
        r"C:\MAGO_Viewer\MAGO_Viewer_CLIENT_BDD_ACCES",
        r"C:\MAGO_Viewer\MAGO Viewer",
    ])

    seen = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        api = os.path.join(candidate, "api", "mago-enrichment-api")
        if os.path.isdir(api) and os.path.isfile(os.path.join(api, "package.json")):
            return candidate
    raise RuntimeError("Dossier MAGO introuvable : impossible de trouver api\\mago-enrichment-api.")


PROJECT_ROOT = find_project_root()
CONFIG = {
    "VIEWER_DIR": PROJECT_ROOT,
    "API_DIR": os.path.join(PROJECT_ROOT, "api", "mago-enrichment-api"),
    "PG_BIN": r"C:\PGSQL\pgsql\bin",
    "PG_DATA": r"C:\PGSQL\pgdata",
    "API_PORT": 3001,
    "PG_PORT": 5432,
}


def port_open(port, host="127.0.0.1"):
    sock = socket.socket()
    sock.settimeout(0.4)
    try:
        return sock.connect_ex((host, port)) == 0
    finally:
        sock.close()


def api_healthy():
    try:
        with urllib.request.urlopen("http://127.0.0.1:3001/api/health", timeout=1.0) as response:
            return response.status == 200
    except Exception:
        return False


def wait_until(check, timeout_seconds):
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if check():
            return True
        time.sleep(0.4)
    return False


def open_log(filename):
    log_dir = os.path.join(CONFIG["VIEWER_DIR"], "logs")
    os.makedirs(log_dir, exist_ok=True)
    handle = open(os.path.join(log_dir, filename), "a", encoding="utf-8")
    LOG_HANDLES.append(handle)
    return handle


def run_npm(cwd, script, log_name):
    log = open_log(log_name)
    process = subprocess.Popen(
        ["cmd", "/c", "npm", "run", script],
        cwd=cwd,
        creationflags=CREATE_NO_WINDOW,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    STARTED_PROCS.append(process)
    return process


def find_pg_bin():
    """Locate a PostgreSQL bin directory: PATH, portable, then Program Files."""
    found = shutil.which("psql")
    if found:
        return os.path.dirname(found)
    if os.path.isdir(CONFIG["PG_BIN"]):
        return CONFIG["PG_BIN"]
    base = r"C:\Program Files\PostgreSQL"
    if os.path.isdir(base):
        for name in sorted(os.listdir(base), reverse=True):
            candidate = os.path.join(base, name, "bin")
            if os.path.isfile(os.path.join(candidate, "pg_ctl.exe")):
                return candidate
    return None


def find_pg_service():
    """Return the name of a 'postgresql*' Windows service, or None."""
    try:
        out = subprocess.check_output(
            ["powershell", "-NoProfile", "-Command",
             "Get-Service -ErrorAction SilentlyContinue | "
             "Where-Object { $_.Name -like 'postgresql*' } | "
             "Sort-Object Name -Descending | "
             "Select-Object -First 1 -ExpandProperty Name"],
            creationflags=CREATE_NO_WINDOW,
            stderr=subprocess.DEVNULL,
        )
        name = out.decode("ascii", "ignore").strip()
        return name or None
    except Exception:
        return None


def pg_reachable():
    """True if PostgreSQL can be started one way or another."""
    return (port_open(CONFIG["PG_PORT"])
            or find_pg_service() is not None
            or os.path.isfile(os.path.join(CONFIG["PG_DATA"], "PG_VERSION")))


def start_postgres():
    global STARTED_PG, STOP_PGCTL
    if port_open(CONFIG["PG_PORT"]):
        ui("PostgreSQL est deja en marche.", 25)
        return

    ui("Demarrage de PostgreSQL...", 10)

    # 1. Standard install: start the Windows service.
    service = find_pg_service()
    if service:
        subprocess.run(
            ["powershell", "-NoProfile", "-Command", "Start-Service", "-Name", service],
            creationflags=CREATE_NO_WINDOW,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if wait_until(lambda: port_open(CONFIG["PG_PORT"]), 20):
            ui("PostgreSQL est pret.", 30)
            return

    # 2. Portable install: pg_ctl on a data directory.
    pg_bin = find_pg_bin()
    if pg_bin and os.path.isfile(os.path.join(CONFIG["PG_DATA"], "PG_VERSION")):
        pgctl = os.path.join(pg_bin, "pg_ctl.exe")
        server_log = os.path.join(os.path.dirname(CONFIG["PG_DATA"]), "postgresql.log")
        subprocess.run(
            [pgctl, "-D", CONFIG["PG_DATA"], "-l", server_log, "start"],
            creationflags=CREATE_NO_WINDOW,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        STARTED_PG = True
        STOP_PGCTL = pgctl

    if not wait_until(lambda: port_open(CONFIG["PG_PORT"]), 20):
        raise RuntimeError(
            "PostgreSQL n'a pas pu demarrer (ni service Windows, "
            "ni base portable dans {}).".format(CONFIG["PG_DATA"])
        )
    ui("PostgreSQL est pret.", 30)


def start_api():
    if api_healthy():
        ui("L'API est deja en marche.", 50)
        return
    ui("Demarrage de l'API...", 40)
    # start = production-like server. The viewer has already been built into api/.../public.
    run_npm(CONFIG["API_DIR"], "start", "api.log")
    if not wait_until(api_healthy, 40):
        raise RuntimeError("L'API ne repond pas. Consulte logs\\api.log.")
    ui("L'API est prete.", 60)


def validate_paths():
    for key in ("VIEWER_DIR", "API_DIR"):
        path = CONFIG[key]
        if not os.path.exists(path):
            raise RuntimeError("Chemin introuvable : {} = {}".format(key, path))
    if shutil.which("npm") is None:
        raise RuntimeError("npm est introuvable. Node.js doit etre installe.")
    if not os.path.exists(os.path.join(CONFIG["API_DIR"], ".env")):
        raise RuntimeError("Fichier .env introuvable dans l'API. Copie .env.example vers .env et renseigne PostgreSQL.")
    if not pg_reachable():
        raise RuntimeError(
            "PostgreSQL introuvable : ni service Windows, "
            "ni base portable dans {}.".format(CONFIG["PG_DATA"])
        )


def boot():
    try:
        ui("Verification des dossiers...", 5)
        validate_paths()
        start_postgres()
        start_api()
        ui("Ouverture du navigateur...", 96)
        webbrowser.open("http://127.0.0.1:3001/")
        ui("MAGO est pret.", 100)
    except Exception as exc:
        ui("Erreur : {}".format(exc), 0)


def shutdown():
    for process in STARTED_PROCS:
        try:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                creationflags=CREATE_NO_WINDOW,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass

    if STARTED_PG and STOP_PGCTL:
        try:
            subprocess.run(
                [STOP_PGCTL, "-D", CONFIG["PG_DATA"], "stop", "-m", "fast"],
                creationflags=CREATE_NO_WINDOW,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass

    for handle in LOG_HANDLES:
        try:
            handle.close()
        except Exception:
            pass

    try:
        root.destroy()
    finally:
        os._exit(0)


BG = "#16181c"
root = tk.Tk()
root.title("MAGO")
root.geometry("440x300")
root.configure(bg=BG)
root.resizable(False, False)

try:
    root.iconbitmap(resource_path("MAGO_viewer_icon.ico"))
except Exception:
    pass

_logo_ref = None
try:
    _logo_ref = tk.PhotoImage(file=resource_path("mago_logo.png"))
    tk.Label(root, image=_logo_ref, bg=BG).pack(pady=(20, 2))
except Exception:
    tk.Label(root, text="MAGO", fg="#7dd3c0", bg=BG, font=("Segoe UI", 22, "bold")).pack(pady=(22, 2))

tk.Label(
    root,
    text="Viewer + base d'enrichissement",
    fg="#7a8089",
    bg=BG,
    font=("Segoe UI", 9),
).pack()

status_var = tk.StringVar(value="Initialisation...")
tk.Label(
    root,
    textvariable=status_var,
    fg="#e8eaed",
    bg=BG,
    font=("Segoe UI", 10),
    wraplength=400,
    justify="center",
).pack(pady=(16, 8))

style = ttk.Style()
try:
    style.theme_use("default")
except Exception:
    pass
style.configure(
    "Mago.Horizontal.TProgressbar",
    troughcolor="#242830",
    background="#7dd3c0",
    bordercolor="#242830",
    lightcolor="#7dd3c0",
    darkcolor="#7dd3c0",
)
prog_var = tk.DoubleVar(value=0)
ttk.Progressbar(
    root,
    orient="horizontal",
    length=380,
    mode="determinate",
    maximum=100,
    variable=prog_var,
    style="Mago.Horizontal.TProgressbar",
).pack(pady=(0, 14))

tk.Button(
    root,
    text="Tout arreter et quitter",
    command=shutdown,
    bg="#242830",
    fg="#e8eaed",
    activebackground="#2c313a",
    relief="flat",
    font=("Segoe UI", 10),
    padx=12,
    pady=6,
).pack()


def ui(message=None, percent=None):
    if message is not None:
        root.after(0, status_var.set, message)
    if percent is not None:
        root.after(0, prog_var.set, percent)


root.protocol("WM_DELETE_WINDOW", shutdown)
threading.Thread(target=boot, daemon=True).start()
root.mainloop()
