# -*- coding: ascii -*-
"""MAGO launcher: starts PostgreSQL, the enrichment API, and the viewer."""

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

CONFIG = {
    "VIEWER_DIR": r"C:\MAGO_Viewer\MAGO Viewer",
    "API_DIR": r"C:\MAGO_Viewer\MAGO Viewer\api\mago-enrichment-api",
    "PG_BIN": r"C:\PGSQL\pgsql\bin",
    "PG_DATA": r"C:\PGSQL\pgdata",
    "API_PORT": 3001,
    "PG_PORT": 5432,
}

CREATE_NO_WINDOW = 0x08000000
STARTED_PROCS = []
STARTED_PG = False
LOG_HANDLES = []


def resource_path(name):
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, name)


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


def run_npm(cwd, log_name):
    log = open_log(log_name)
    process = subprocess.Popen(
        ["cmd", "/c", "npm", "run", "dev"],
        cwd=cwd,
        creationflags=CREATE_NO_WINDOW,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    STARTED_PROCS.append(process)
    return process


def start_postgres():
    global STARTED_PG
    if port_open(CONFIG["PG_PORT"]):
        ui("PostgreSQL est deja en marche.", 25)
        return

    ui("D\u00e9marrage de PostgreSQL...", 10)
    pgctl = os.path.join(CONFIG["PG_BIN"], "pg_ctl.exe")
    server_log = os.path.join(CONFIG["PG_DATA"], "server.log")
    result = subprocess.run(
        [pgctl, "-D", CONFIG["PG_DATA"], "-l", server_log, "start"],
        creationflags=CREATE_NO_WINDOW,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if result.returncode != 0 and not port_open(CONFIG["PG_PORT"]):
        raise RuntimeError("PostgreSQL n'a pas pu demarrer. Consulte server.log.")
    if not wait_until(lambda: port_open(CONFIG["PG_PORT"]), 20):
        raise RuntimeError("PostgreSQL ne repond pas sur le port 5432.")
    STARTED_PG = True
    ui("PostgreSQL est pr\u00eat.", 30)


def start_api():
    if api_healthy():
        ui("L'API est deja en marche.", 50)
        return
    ui("D\u00e9marrage de l'API...", 40)
    run_npm(CONFIG["API_DIR"], "api.log")
    if not wait_until(api_healthy, 40):
        raise RuntimeError("L'API ne repond pas. Consulte logs\\api.log.")
    ui("L'API est pr\u00eate.", 60)


def validate_paths():
    for key in ("VIEWER_DIR", "API_DIR", "PG_BIN", "PG_DATA"):
        path = CONFIG[key]
        if not os.path.exists(path):
            raise RuntimeError("Chemin introuvable : {} = {}".format(key, path))
    if shutil.which("npm") is None:
        raise RuntimeError("npm est introuvable. Node.js doit etre installe.")


def boot():
    try:
        ui("V\u00e9rification des dossiers...", 5)
        validate_paths()
        start_postgres()
        start_api()
        ui("Ouverture du navigateur...", 96)
        webbrowser.open("http://127.0.0.1:3001")
        ui("MAGO est pr\u00eat.", 100)
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

    if STARTED_PG:
        try:
            subprocess.run(
                [os.path.join(CONFIG["PG_BIN"], "pg_ctl.exe"), "-D", CONFIG["PG_DATA"], "stop", "-m", "fast"],
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
    text="Tout arr\u00eater et quitter",
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
