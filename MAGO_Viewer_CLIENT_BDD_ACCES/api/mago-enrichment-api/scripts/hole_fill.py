#!/usr/bin/env python3
"""
Rebouchage d'un trou de maillage a partir du nuage de points classifie.

Principe (issu de la contrainte metier : un trou est toujours SUR un objet,
jamais a cheval sur deux) :

  1. On isole la boucle de bord selectionnee par l'utilisateur.
  2. On interroge le nuage dans l'emprise de la boucle, EN NE GARDANT QUE les
     points de la meme classe que l'objet. C'est la classification qui resout
     l'ambiguite "ce point appartient-il au mur ou a la chaise devant ?".
  3. On ajuste un plan (les trous concernes -- tableau, ecran, mur -- sont
     plans ; c'est le mailleur photogrammetrique qui decroche sur les surfaces
     sans contraste, pas le scanner).
  4. Triangulation de Delaunay dans le plan, sur bord + points du nuage.
  5. On coupe tout ce qui sort du polygone de bord, puis on soude.

Provenance produite :
  - "mesure"    : le nuage avait des points, on a recupere de la donnee reelle
  - "interpole" : aucun point, on a triangule le bord seul (Liepa planaire)
Aucune face n'est inventee sans etre marquee.
"""

import sys
import numpy as np
from scipy.spatial import cKDTree
import triangle
from collections import defaultdict


# ------------------------------------------------------------------ #
#  Extraction des boucles de bord                                     #
# ------------------------------------------------------------------ #

def boundary_loops(faces, n_vertices):
    """Boucles d'aretes de bord, ordonnees. Retourne une liste de listes d'indices."""
    E = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    a, b = E.min(1), E.max(1)
    key = a.astype(np.int64) * (n_vertices + 1) + b
    uk, cnt = np.unique(key, return_counts=True)
    bk = uk[cnt == 1]
    if len(bk) == 0:
        return []

    ba = (bk // (n_vertices + 1)).astype(np.int64)
    bb = (bk % (n_vertices + 1)).astype(np.int64)

    adj = defaultdict(list)
    for u, v in zip(ba, bb):
        adj[u].append(v)
        adj[v].append(u)

    loops, seen = [], set()
    for start in list(adj.keys()):
        if start in seen:
            continue
        loop, cur, prev = [start], start, None
        seen.add(start)
        while True:
            nxts = [w for w in adj[cur] if w != prev]
            nxts = [w for w in nxts if w not in seen or w == start]
            if not nxts:
                break
            nxt = nxts[0]
            if nxt == start:
                break
            loop.append(nxt)
            seen.add(nxt)
            prev, cur = cur, nxt
        if len(loop) >= 3:
            loops.append(loop)
    return loops


# ------------------------------------------------------------------ #
#  Geometrie                                                          #
# ------------------------------------------------------------------ #

def fit_plane(P):
    """Plan des moindres carres par PCA. Retourne (origine, base 2D, normale)."""
    c = P.mean(0)
    U, S, Vt = np.linalg.svd(P - c, full_matrices=False)
    normal = Vt[2]
    e1, e2 = Vt[0], Vt[1]
    rms = float(np.sqrt((((P - c) @ normal) ** 2).mean()))
    return c, np.stack([e1, e2]), normal, rms


def to_plane(P, origin, basis):
    return (P - origin) @ basis.T


def point_in_polygon(pts, poly):
    """Ray casting vectorise. pts (N,2), poly (M,2) ferme implicitement."""
    x, y = pts[:, 0], pts[:, 1]
    inside = np.zeros(len(pts), bool)
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        cond = ((yi > y) != (yj > y)) & (
            x < (xj - xi) * (y - yi) / np.where(yj - yi == 0, 1e-12, yj - yi) + xi)
        inside ^= cond
        j = i
    return inside


def _idw(q2, ref2, ref_rgb, k=6, power=2.0):
    """Couleur par distance inverse aux k sommets de bord les plus proches."""
    if len(ref2) == 0 or len(q2) == 0:
        return np.zeros((len(q2), 3))
    t = cKDTree(ref2)
    kk = min(k, len(ref2))
    d, i = t.query(q2, k=kk)
    d = np.atleast_2d(d.T).T if kk > 1 else d.reshape(-1, 1)
    i = np.atleast_2d(i.T).T if kk > 1 else i.reshape(-1, 1)
    w = 1.0 / np.maximum(d, 1e-6) ** power
    w /= w.sum(1, keepdims=True)
    return (ref_rgb[i].astype(np.float64) * w[:, :, None]).sum(1)


# ------------------------------------------------------------------ #
#  Rebouchage                                                         #
# ------------------------------------------------------------------ #

def fill_hole(mesh_v, loop_idx, cloud_xyz=None, cloud_class=None,
              target_class=None, max_plane_rms=0.08, decim=0.02,
              cloud_rgb=None, boundary_rgb=None):
    """
    mesh_v      : (N,3) sommets du maillage
    loop_idx    : indices des sommets de la boucle de bord, ordonnes
    cloud_xyz   : (M,3) nuage source deja recale sur le maillage
    cloud_class : (M,) classe par point, ou None
    target_class: classe de l'objet portant le trou
    decim       : pas de decimation du nuage (m), pour ne pas sur-densifier

    Retourne (new_vertices, new_faces, info)
    """
    B = mesh_v[loop_idx]
    origin, basis, normal, rms = fit_plane(B)
    info = {"plane_rms": rms, "n_boundary": len(loop_idx)}

    if rms > max_plane_rms:
        info["status"] = "non_planaire"
        info["provenance"] = None
        return None, None, info, None

    B2 = to_plane(B, origin, basis)

    # --- points du nuage : dans l'emprise ET de la bonne classe -------
    used = np.zeros((0, 3))
    used_rgb = None
    if cloud_xyz is not None and len(cloud_xyz):
        sel = np.ones(len(cloud_xyz), bool)

        # 1) filtre classe : c'est lui qui evite d'aspirer la chaise devant le mur
        if cloud_class is not None and target_class is not None:
            sel &= (cloud_class == target_class)

        # 2) proximite du plan
        d = np.abs((cloud_xyz - origin) @ normal)
        sel &= d < max(3 * rms, 0.03)

        # 3) dans le polygone de bord
        if sel.any():
            P2 = to_plane(cloud_xyz[sel], origin, basis)
            keep = point_in_polygon(P2, B2)
            idx = np.nonzero(sel)[0][keep]
            used = cloud_xyz[idx]
            used_rgb = cloud_rgb[idx] if cloud_rgb is not None else None

        # 4) decimation par grille : evite 200k points dans un trou de 30 cm
        if len(used) > 0 and decim > 0:
            g = np.floor(used / decim).astype(np.int64)
            _, uniq = np.unique(g, axis=0, return_index=True)
            keep2 = np.sort(uniq)
            used = used[keep2]
            if used_rgb is not None:
                used_rgb = used_rgb[keep2]

    info["n_cloud_points"] = len(used)
    info["provenance"] = "mesure" if len(used) >= 3 else "interpole"

    # --- triangulation dans le plan -----------------------------------
    if len(used):
        U2 = to_plane(used, origin, basis)
        pts2 = np.vstack([B2, U2])
    else:
        pts2 = B2

    if len(pts2) < 3:
        info["status"] = "trop_peu_de_points"
        return None, None, info, None

    # Delaunay NON contraint ne garantit pas que les aretes du bord existent
    # dans la triangulation : le decoupage a posteriori laisse alors des
    # lamelles et le rebouchage n'est pas etanche. On impose donc le bord comme
    # contrainte (CDT de Shewchuk) : chaque arete du contour est une arete du
    # maillage produit, la soudure est exacte par construction.
    nb = len(B2)
    segs = np.stack([np.arange(nb), (np.arange(nb) + 1) % nb], axis=1)
    try:
        out = triangle.triangulate(
            {"vertices": pts2, "segments": segs},
            "p")                       # 'p' = PSLG : respecte les segments
    except Exception as e:
        info["status"] = f"cdt_echec: {e}"
        return None, None, info, None

    if "triangles" not in out or len(out["triangles"]) == 0:
        info["status"] = "cdt_sans_triangle"
        return None, None, info, None

    # La CDT peut inserer des points de Steiner ; on les recupere en 3D par
    # elevation sur le plan (ils n'existent pas dans le nuage).
    verts2 = np.asarray(out["vertices"], float)
    simp = np.asarray(out["triangles"], np.int64)
    n_steiner = len(verts2) - len(pts2)
    info["n_steiner"] = n_steiner

    # 'p' triangule l'interieur du polygone : reste a ecarter l'exterieur du
    # contour si le polygone est concave (triangle le fait via les trous, mais
    # on verifie explicitement plutot que de faire confiance).
    cent = verts2[simp].mean(1)
    keep = point_in_polygon(cent, B2)
    simp = simp[keep]

    if len(simp) == 0:
        info["status"] = "aucun_triangle_interieur"
        return None, None, info, None

    # --- sommets 3D : le bord garde ses indices d'origine (soudure)
    # Les points du nuage gardent leur position 3D MESUREE : la topologie vient
    # de la projection 2D, pas la geometrie. On ne les aplatit pas sur le plan,
    # sinon on detruirait le micro-relief qu'on cherchait justement a recuperer.
    extra = used if len(used) else np.zeros((0, 3))
    if n_steiner > 0:
        st2 = verts2[len(pts2):]
        st3 = origin + st2 @ basis          # Steiner : pas de mesure, on eleve
        new_v3 = np.vstack([extra, st3]) if len(extra) else st3
    else:
        new_v3 = extra

    # --- couleurs -----------------------------------------------------
    # Points du nuage : couleur MESUREE. Points de Steiner et cas interpole :
    # aucune mesure n'existe, on pondere par distance inverse aux couleurs du
    # bord (dans le plan). Un trou dans le tableau rend donc du vert de
    # tableau, pas une pastille grise.
    new_rgb = None
    if boundary_rgb is not None:
        parts = []
        if len(used):
            if used_rgb is not None:
                parts.append(used_rgb.astype(np.float64))
            else:
                parts.append(_idw(to_plane(used, origin, basis), B2, boundary_rgb))
        if n_steiner > 0:
            parts.append(_idw(verts2[len(pts2):], B2, boundary_rgb))
        if parts:
            new_rgb = np.clip(np.vstack(parts), 0, 255).astype(np.uint8)
        else:
            new_rgb = np.zeros((0, 3), np.uint8)

    nbv = len(loop_idx)
    remap = np.empty(len(verts2), np.int64)
    remap[:nbv] = np.asarray(loop_idx)                          # bord existant
    remap[nbv:len(pts2)] = len(mesh_v) + np.arange(len(extra))  # points mesures
    remap[len(pts2):] = len(mesh_v) + len(extra) + np.arange(n_steiner)
    faces = remap[simp]

    # --- orientation coherente avec la normale du plan
    v0, v1, v2 = (np.vstack([mesh_v, new_v3])[faces[:, i]] for i in range(3))
    fn = np.cross(v1 - v0, v2 - v0)
    flip = (fn @ normal) < 0
    faces[flip] = faces[flip][:, [0, 2, 1]]

    info["status"] = "ok"
    info["n_faces"] = len(faces)
    info["color_source"] = ("nuage" if (used_rgb is not None and len(used))
                            else ("bord" if boundary_rgb is not None else "aucune"))
    return new_v3, faces, info, new_rgb


# ------------------------------------------------------------------ #
#  CLI : appele par l'API Fastify                                     #
# ------------------------------------------------------------------ #
#
# Le front possede deja la geometrie : il extrait la boucle de bord et
# n'envoie que ses coordonnees. Le backend n'a donc jamais besoin du
# maillage, seulement du nuage. Les faces renvoyees sont indexees ainsi :
#   0 .. nb-1  -> sommets du bord, dans l'ordre envoye (le front les remappe)
#   nb ..      -> nouveaux sommets, dans l'ordre de "vertices"

def _load_cloud(path):
    from plyfile import PlyData
    ply = PlyData.read(path)
    el = ply["vertex"]
    xyz = np.stack([el["x"], el["y"], el["z"]], axis=1).astype(np.float64)

    rgb = None
    names = el.data.dtype.names
    for trio in (("red", "green", "blue"), ("r", "g", "b"),
                 ("diffuse_red", "diffuse_green", "diffuse_blue")):
        if all(n in names for n in trio):
            rgb = np.stack([el[trio[0]], el[trio[1]], el[trio[2]]], axis=1)
            if rgb.dtype.kind == "f":          # certains exports sont en 0..1
                rgb = (np.clip(rgb, 0, 1) * 255)
            rgb = rgb.astype(np.uint8)
            break

    cls = None
    for name in ("scalar_Classification", "classification", "class", "label"):
        if name in el.data.dtype.names:
            cls = np.asarray(el[name]).astype(np.int64)
            break
    return xyz, cls, rgb


def main():
    import json as _json
    req = _json.load(sys.stdin)

    boundary = np.asarray(req["boundary"], float)
    if len(boundary) < 3:
        print(_json.dumps({"info": {"status": "bord_trop_court"}}))
        return

    xyz = cls = rgb = None
    if req.get("cloud_path"):
        xyz, cls, rgb = _load_cloud(req["cloud_path"])
        # pre-filtre grossier sur la bbox du bord : evite de porter des
        # millions de points jusqu'au test polygone
        lo = boundary.min(0) - 0.25
        hi = boundary.max(0) + 0.25
        m = np.all((xyz >= lo) & (xyz <= hi), axis=1)
        xyz = xyz[m]
        cls = cls[m] if cls is not None else None
        rgb = rgb[m] if rgb is not None else None

    brgb = req.get("boundary_rgb")
    brgb = np.asarray(brgb, np.uint8) if brgb else None

    newv, newf, info, newc = fill_hole(
        boundary, np.arange(len(boundary)),
        cloud_xyz=xyz, cloud_class=cls,
        target_class=req.get("target_class"),
        max_plane_rms=req.get("max_plane_rms", 0.08),
        decim=req.get("decim", 0.02),
        cloud_rgb=rgb, boundary_rgb=brgb,
    )

    out = {"info": info}
    if newf is not None:
        out["vertices"] = newv.tolist()
        out["faces"] = newf.tolist()
        if newc is not None:
            out["colors"] = newc.tolist()      # couleur MESUREE, pas un marquage
    print(_json.dumps(out))


if __name__ == "__main__":
    main()
