/**
 * Internationalisation (i18n) de MAGO Viewer.
 *
 * Principe : le FRANÇAIS est la clé. La traduction du DOM se fait par
 * correspondance exacte sur les nœuds texte et attributs affichés
 * (placeholder, title, aria-label). Un MutationObserver traduit aussi les
 * panneaux créés dynamiquement. Ce qui n'est pas au dictionnaire reste en
 * français — jamais d'erreur.
 *
 * La langue est mémorisée dans localStorage ("mago_language").
 */

const STORAGE_KEY = "mago_language";
type Lang = "fr" | "en";

export function getLanguage(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "en" ? "en" : "fr";
  } catch {
    return "fr";
  }
}

export function setLanguage(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* le stockage peut être indisponible : on continue en mémoire */
  }
}

/** Traduit une chaîne française (identité si fr ou clé inconnue). */
export function t(text: string): string {
  if (getLanguage() === "fr") return text;
  return EN[text] ?? text;
}

/** Traduit un message pouvant contenir un préfixe connu suivi d'une partie dynamique. */
export function tMsg(message: string): string {
  if (getLanguage() === "fr") return message;
  const direct = EN[message];
  if (direct) return direct;
  for (const prefix of PREFIXES) {
    if (message.startsWith(prefix)) {
      return (EN[prefix] ?? prefix) + message.slice(prefix.length);
    }
  }
  return message;
}

/* ------------------------------------------------------------------ */
/*  Traduction du DOM                                                  */
/* ------------------------------------------------------------------ */

const ATTRS = ["placeholder", "title", "aria-label"] as const;

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
let NORM_EN: Record<string, string> | null = null;
function normDict(): Record<string, string> {
  if (!NORM_EN) {
    NORM_EN = {};
    for (const k of Object.keys(EN)) NORM_EN[norm(k)] = EN[k];
  }
  return NORM_EN;
}

function translateTextNode(node: Text): void {
  const raw = node.textContent ?? "";
  const trimmed = norm(raw);
  if (!trimmed) return;
  const en = normDict()[trimmed];
  // Ne jamais réécrire un texte identique : une écriture à l'identique
  // déclenche quand même le MutationObserver et créerait une boucle infinie.
  if (en && en !== trimmed) node.textContent = en;
}

function translateElement(el: Element): void {
  for (const attr of ATTRS) {
    const v = el.getAttribute(attr);
    if (v && EN[v] && EN[v] !== v) el.setAttribute(attr, EN[v]);
  }
}

function walk(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root as Text);
    return;
  }
  if (root.nodeType === Node.ELEMENT_NODE) {
    translateElement(root as Element);
  }
  root.childNodes.forEach(walk);
}

let observer: MutationObserver | null = null;

/** Initialise l'i18n : traduit la page si EN, installe l'observateur et le sélecteur. */
export function initI18n(): void {
  injectLanguageSelector();
  if (getLanguage() !== "en") return;
  walk(document.body);
  document.title = EN[document.title] ?? document.title;
  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "characterData" && m.target.nodeType === Node.TEXT_NODE) {
        translateTextNode(m.target as Text);
      }
      m.addedNodes.forEach(walk);
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

function injectLanguageSelector(): void {
  const host =
    document.querySelector(".toolbar-actions") ?? document.getElementById("toolbar");
  if (!host) return;
  const select = document.createElement("select");
  select.id = "mago-language-select";
  select.style.cssText =
    "margin-left:8px;background:#1d242c;color:#eaf6ff;border:1px solid #3e4b59;border-radius:4px;padding:2px 6px;font-size:12px;";
  for (const [value, label] of [["fr", "FR"], ["en", "EN"]] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    if (getLanguage() === value) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    setLanguage(select.value as Lang);
    location.reload();
  });
  host.prepend(select);
}

/* ------------------------------------------------------------------ */
/*  Préfixes de messages dynamiques (message = préfixe + détail)       */
/* ------------------------------------------------------------------ */

const PREFIXES: string[] = [
  "Annuler dernière suppression · ",
  "Échec SOR : ",
  "Échec de la capture : ",
  "Échec du chargement de la scène : ",
  "Échec export GLB : ",
  "Échec export GS PLY modifié : ",
  "Échec export OBJ MAGO : ",
  "Échec export PLY MAGO : ",
  "Échec export ZIP : ",
  "Échec filtre distance au mesh : ",
  "Erreur pendant la sélection mesh : ",
  "Attribut non sauvegardé en base : ",
  "Attribut non supprimé : ",
];

/* ------------------------------------------------------------------ */
/*  Dictionnaire français → anglais                                    */
/* ------------------------------------------------------------------ */

const EN: Record<string, string> = {
  // --- Marque / titres ---
  "MAGO Viewer · TFE": "MAGO Viewer",
  "MAGO Viewer": "MAGO Viewer",
  "TFE · Nathan BATAILLARD": "",

  // --- Barre d'outils / panneaux ---
  "Outils ▾": "Tools ▾",
  "Outils avancés": "Advanced tools",
  "Afficher / masquer le panneau": "Show / hide panel",
  "Étirer le panneau": "Stretch panel",
  "Scène": "Scene",
  "Rendu": "Rendering",
  "Caméra": "Camera",
  "Performance": "Performance",
  "Qualité": "Quality",
  "Équilibré": "Balanced",
  "État": "Status",
  "Inactif": "Inactive",
  "Import": "Import",
  "Export": "Export",
  "Mesure": "Measure",
  "Transformations": "Transforms",
  "Édition mesh": "Mesh editing",
  "Édition splats": "Splat editing",
  "Enrichissement sémantique": "Semantic enrichment",
  "Manipulation interactive": "Interactive manipulation",
  "Objets importés": "Imported objects",
  "Objets du GLB / mesh": "GLB / mesh objects",
  "Objet sélectionné": "Selected object",
  "Détails du mesh actif": "Active mesh details",
  "Viewer actuel": "Current viewer",
  "Dimensions": "Dimensions",

  // --- Chargement / import ---
  "+ GS": "+ GS",
  "+ MAGO Tiles": "+ MAGO Tiles",
  "+ Mesh / OBJ": "+ Mesh / OBJ",
  "+ Nuage": "+ Point cloud",
  "Glisse-dépose ici : mesh GLB/PLY/OBJ · splats · nuage PLY · scene_tiles.json":
    "Drag & drop here: GLB/PLY/OBJ mesh · splats · PLY point cloud · scene_tiles.json",
  "Charge un GLB/mesh pour voir ses couches.": "Load a GLB/mesh to see its layers.",
  "Charge une sortie MAGO Pipeline V42 : scene_tiles.json + dossier tiles":
    "Load a MAGO Pipeline V42 output: scene_tiles.json + tiles folder",
  "Chargement de la scène…": "Loading scene…",
  "Scène chargée.": "Scene loaded.",
  "Viewer prêt. Charge un mesh et/ou un fichier de splats pour commencer.":
    "Viewer ready. Load a mesh and/or a splat file to start.",
  "Très gros fichiers": "Very large files",
  "Charger config JSON": "Load JSON config",
  "Importer matrice .txt": "Import .txt matrix",
  "Ton navigateur ne supporte pas le chargement de dossier. Utilise Chrome ou Edge récent.":
    "Your browser does not support folder loading. Use a recent Chrome or Edge.",
  "Aucun asset chargé.": "No asset loaded.",

  // --- Mesure ---
  "Mode de mesure": "Measure mode",
  "Distance — 2 points": "Distance — 2 points",
  "Surface — contour": "Surface — outline",
  "Activer (touche M)": "Enable (M key)",
  "Distance": "Distance",
  "Surface": "Surface",
  "Points": "Points",
  "Annuler dernier point": "Undo last point",
  "Fermer surface": "Close surface",
  "Effacer": "Clear",
  "Effacer points": "Clear points",

  // --- Alignement par points ---
  "Alignement par points": "Point-pair alignment",
  "Source à transformer": "Source to transform",
  "Cible de référence": "Reference target",
  "Splats": "Splats",
  "Mesh sélectionné / principal": "Selected / main mesh",
  "Nuage sélectionné / premier visible": "Selected / first visible point cloud",
  "Repère matrice importée": "Imported matrix frame",
  "Activer picking": "Enable picking",
  "Masquer la référence pendant le piquage": "Hide reference while picking",
  "Masquer la source pendant le piquage": "Hide source while picking",
  "Paires": "Pairs",
  "0 paire": "0 pair",
  "Ajoute au moins une paire source/cible.": "Add at least one source/target pair.",
  "Alignement activé : clique un point SOURCE puis le point CIBLE correspondant. Minimum 3 paires pour une matrice rigide.":
    "Alignment enabled: click a SOURCE point then the matching TARGET point. At least 3 pairs for a rigid matrix.",
  "Alignement désactivé.": "Alignment disabled.",
  "Point source pris. Clique maintenant le point cible correspondant.":
    "Source point set. Now click the matching target point.",
  "Points d’alignement effacés.": "Alignment points cleared.",
  "Pour une rotation fiable, ajoute 3 paires. Avec 1 paire, seule une translation est calculée.":
    "For a reliable rotation, add 3 pairs. With 1 pair only a translation is computed.",
  "Calculer / appliquer matrice": "Compute / apply matrix",
  "Appliquer la matrice à la source dans le viewer": "Apply the matrix to the source in the viewer",
  "Estimer automatiquement (similarité)": "Estimate automatically (similarity)",
  "Garder l'échelle (rigide)": "Keep scale (rigid)",
  "Échelle de la source": "Source scale",
  "Facteur d'échelle": "Scale factor",
  "Facteur manuel…": "Manual factor…",
  "Matrice calculée": "Computed matrix",
  "La matrice 4x4 apparaîtra ici après calcul.": "The 4x4 matrix will appear here after computing.",
  "Matrice invalide : il faut 16 nombres.": "Invalid matrix: 16 numbers are required.",
  "Calcul impossible : les points sont peut-être alignés ou trop proches.":
    "Cannot compute: points may be collinear or too close.",
  "Erreur RMS": "RMS error",
  "Erreur max": "Max error",
  "cible": "target",

  // --- Transformations ---
  "Déplacer": "Move",
  "Rotation": "Rotation",
  "Échelle": "Scale",
  "Rot X": "Rot X",
  "Rot Y": "Rot Y",
  "Rot Z": "Rot Z",
  "Reset": "Reset",
  "Reset toutes les transformations": "Reset all transforms",
  "Transformations réinitialisées.": "Transforms reset.",
  "Centrer l'objet sur l'origine": "Center object on origin",
  "Recentrer sur la scène": "Recenter on scene",
  "Recadrer après modif": "Refit after edit",
  "Z-up → Y-up": "Z-up → Y-up",
  "MAGO / CloudCompare Z-up": "MAGO / CloudCompare Z-up",
  "Sélectionne d’abord un objet dans « Objets importés ».":
    "First select an object in “Imported objects”.",
  "Sélectionne un objet dans « Objets importés » pour modifier uniquement celui-ci.":
    "Select an object in “Imported objects” to edit only that one.",
  "Impossible de calculer la boîte englobante de cet objet.":
    "Cannot compute this object's bounding box.",

  // --- Sélection / édition mesh ---
  "Mode de sélection": "Selection mode",
  "Lasso libre": "Free lasso",
  "Rectangle": "Rectangle",
  "Rond": "Circle",
  "Pinceau": "Brush",
  "Taille pinceau": "Brush size",
  "Activer sélection mesh": "Enable mesh selection",
  "Activer sélection écran": "Enable screen selection",
  "Sélectionner mesh": "Select mesh",
  "Sélectionner splats": "Select splats",
  "Supprimer sélection mesh": "Delete mesh selection",
  "Supprimer sélection surlignée": "Delete highlighted selection",
  "Masquer sélection (isoler · H)": "Hide selection (isolate · H)",
  "Réafficher faces masquées": "Show hidden faces again",
  "Reclasser la sélection": "Reclassify selection",
  "Reclasser la sélection vers": "Reclassify selection to",
  "Choisis une classe cible.": "Choose a target class.",
  "La sélection est déjà dans cette classe.": "The selection is already in this class.",
  "Aucune sélection mesh.": "No mesh selection.",
  "Aucune sélection mesh à masquer.": "No mesh selection to hide.",
  "Aucune sélection mesh à reclasser.": "No mesh selection to reclassify.",
  "Aucune sélection mesh à supprimer.": "No mesh selection to delete.",
  "Aucune face masquée à réafficher.": "No hidden face to show again.",
  "Aucune sélection à masquer. Sélectionne d’abord (lasso, rectangle, rond ou pinceau).":
    "Nothing selected to hide. Select first (lasso, rectangle, circle or brush).",
  "Aucune sélection à supprimer.": "Nothing selected to delete.",
  "Sélection désactivée.": "Selection disabled.",
  "Sélection effacée.": "Selection cleared.",
  "Sélection mesh désactivée.": "Mesh selection disabled.",
  "Sélection mesh effacée.": "Mesh selection cleared.",
  "Sélection trop petite.": "Selection too small.",
  "Effacer sélection": "Clear selection",
  "Rien à annuler pour le mesh.": "Nothing to undo for the mesh.",
  "Impossible de récupérer les triangles du mesh.": "Cannot read the mesh triangles.",
  "Aucune sous-couche mesh détectée.": "No mesh sub-layer detected.",
  "0 triangle masqué (protégés)": "0 hidden triangle (protected)",
  "0 triangle sélectionné": "0 selected triangle",
  "Astuce : clique un objet dans la liste puis Suppr pour le retirer.":
    "Tip: click an object in the list then Del to remove it.",
  "Supprimer / décharger le mesh": "Remove / unload mesh",
  "Filtrer : mur, sol, table…": "Filter: wall, floor, table…",
  "Tout afficher": "Show all",
  "Tout masquer": "Hide all",

  // --- Édition splats ---
  "Aucun PLY de splats éditable chargé.": "No editable splat PLY loaded.",
  "Aucun splat éditable chargé.": "No editable splat loaded.",
  "Aucun objet splats chargé dans la scène.": "No splat object loaded in the scene.",
  "Aucun objet splats dans la scène.": "No splat object in the scene.",
  "Annuler dernière suppression": "Undo last deletion",
  "Annuler dernière suppression (Ctrl+Z)": "Undo last deletion (Ctrl+Z)",
  "Aucun splat supprimé : rien à restaurer.": "No deleted splat: nothing to restore.",
  "Aucun splat supprimé dans cette zone.": "No deleted splat in this area.",
  "Aucun splat masqué à réafficher.": "No hidden splat to show again.",
  "Plus aucun splat supprimé à restaurer.": "No more deleted splats to restore.",
  "Réafficher splats masqués": "Show hidden splats again",
  "Restaurer splats origine": "Restore original splats",
  "Restaurer supprimés dans une zone": "Restore deleted in an area",
  "Restauration désactivée.": "Restore disabled.",
  "Rien à annuler pour les splats.": "Nothing to undo for splats.",
  "La sélection ne contient aucun splat visible.": "The selection contains no visible splat.",
  "Supprimer / décharger les splats": "Remove / unload splats",
  "Détecter flotteurs (SOR)": "Detect floaters (SOR)",
  "SOR : seuil (n·σ)": "SOR: threshold (n·σ)",
  "SOR : voisins (k)": "SOR: neighbors (k)",
  "Détection SOR déjà en cours…": "SOR detection already running…",
  "Charge un fichier de splats PLY avant de lancer le SOR.":
    "Load a splat PLY file before running SOR.",
  "Détecter splats loin du mesh": "Detect splats far from mesh",
  "Distance au mesh max": "Max distance to mesh",
  "Charge le mesh de référence : ce filtre mesure la distance des splats à sa surface.":
    "Load the reference mesh: this filter measures splat distance to its surface.",
  "Filtre distance au mesh déjà en cours…": "Distance-to-mesh filter already running…",
  "Charge un fichier de splats PLY avant de lancer le filtre.":
    "Load a splat PLY file before running the filter.",
  "Charge un fichier de splats PLY avant de restaurer.":
    "Load a splat PLY file before restoring.",
  "Charge un fichier de splats PLY avant d’utiliser ce filtre.":
    "Load a splat PLY file before using this filter.",
  "Filtrage des splats réinitialisé.": "Splat filtering reset.",
  "Afficher seulement blancs/clairs": "Show only white/light",
  "Afficher tous les splats restants": "Show all remaining splats",
  "Supprimer blancs/clairs détectés": "Delete detected white/light",
  "Aucun splat clair (visible) à supprimer avec ces seuils.":
    "No light (visible) splat to delete with these thresholds.",
  "Luminosité min": "Min brightness",
  "Neutralité blanc/gris": "White/gray neutrality",

  // --- Vues / caméra / rendu ---
  "Vue de face": "Front view",
  "Vue de côté": "Side view",
  "Vue de dessus": "Top view",
  "Vue isométrique": "Isometric view",
  "FRONT": "FRONT",
  "SIDE": "SIDE",
  "TOP": "TOP",
  "ISO": "ISO",
  "Repère XYZ": "XYZ frame",
  "Afficher / masquer le repère central XYZ": "Show / hide the central XYZ frame",
  "Grille au sol": "Ground grid",
  "Couleur de fond": "Background color",
  "Ciel coucher de soleil": "Sunset sky",
  "Solide": "Solid",
  "Solide + arêtes": "Solid + edges",
  "Filaire": "Wireframe",
  "Opacité": "Opacity",
  "Résolution rendu": "Render resolution",
  "Sensibilité souris": "Mouse sensitivity",
  "Vitesse clavier": "Keyboard speed",
  "Vitesse zoom": "Zoom speed",
  "Déplacement clic droit": "Right-click pan",
  "Flèches ou Z/Q/S/D : déplacement type FPS dans le plan horizontal.":
    "Arrow keys or Z/Q/S/D: FPS-style movement in the horizontal plane.",
  "Alléger pendant les déplacements": "Lighten while moving",
  "Auto selon zoom": "Auto by zoom",
  "Contrôle rapide LOD": "Quick LOD control",
  "LOD auto": "Auto LOD",
  "LOD mesh": "Mesh LOD",
  "LOD unique": "Single LOD",
  "Forcer LOD0 / HD": "Force LOD0 / HD",
  "Forcer LOD1 / moyen": "Force LOD1 / medium",
  "Forcer LOD2 / léger": "Force LOD2 / light",
  "Forcer LOD3 / très léger": "Force LOD3 / very light",
  "aucun groupe LOD détecté": "no LOD group detected",
  "Capture d'écran haute résolution": "High-resolution screenshot",
  "Capture exportée.": "Screenshot exported.",
  "Copier la pose": "Copy pose",
  "Pose caméra copiée dans le presse-papier.": "Camera pose copied to clipboard.",

  // --- Export ---
  "Exporter GS PLY modifié (filtré + aligné)": "Export modified GS PLY (filtered + aligned)",
  "Exporter GS aligné définitivement": "Export permanently aligned GS",
  "Exporter PLY filtré": "Export filtered PLY",
  "Exporter config JSON": "Export JSON config",
  "Exporter matrice CloudCompare": "Export CloudCompare matrix",
  "Exporter mesh GLB": "Export GLB mesh",
  "Exporter mesh OBJ (MAGO/CloudCompare)": "Export OBJ mesh (MAGO/CloudCompare)",
  "Exporter mesh PLY (MAGO/CloudCompare)": "Export PLY mesh (MAGO/CloudCompare)",
  "Exporter package ZIP": "Export ZIP package",
  "Copier matrice CloudCompare": "Copy CloudCompare matrix",
  "Copie impossible dans ce navigateur. Utilise Exporter matrice.":
    "Copy not available in this browser. Use Export matrix.",
  "Matrice complète MAGO / CloudCompare copiée dans le presse-papiers.":
    "Full MAGO / CloudCompare matrix copied to clipboard.",
  "Matrice complète exportée : transformations manuelles + alignement par points inclus.":
    "Full matrix exported: manual transforms + point alignment included.",
  "Mesh GLB exporté.": "GLB mesh exported.",
  "Mesh OBJ exporté en repère MAGO / CloudCompare / 3DR.":
    "OBJ mesh exported in MAGO / CloudCompare / 3DR frame.",
  "Mesh PLY exporté en repère MAGO / CloudCompare / 3DR.":
    "PLY mesh exported in MAGO / CloudCompare / 3DR frame.",
  "Package ZIP exporté.": "ZIP package exported.",
  "PLY des splats filtrés exporté. Attention : cet export ne bake pas le déplacement/rotation/échelle du viewer.":
    "Filtered splat PLY exported. Warning: this export does not bake the viewer move/rotation/scale.",
  "Configuration JSON exportée.": "JSON configuration exported.",
  "Configuration JSON appliquée. Recharge les fichiers indiqués si besoin.":
    "JSON configuration applied. Reload the listed files if needed.",
  "Configuration appliquée aux objets chargés (transformations + caméra).":
    "Configuration applied to loaded objects (transforms + camera).",
  "Impossible de lire cette configuration JSON.": "Cannot read this JSON configuration.",

  // --- Enrichissement / base ---
  "Activer l’enrichissement": "Enable enrichment",
  "Aucun modèle actif en base. Charge d'abord un mesh avec l'API démarrée.":
    "No active model in the database. First load a mesh with the API running.",
  "Inspecteur désactivé dans cette version légère.": "Inspector disabled in this light version.",

  // --- Accès client / tunnel ---
  "Accès client — connexion requise": "Client access — sign-in required",
  "Se connecter": "Sign in",
  "Créer vue client": "Create client view",
  "Crée un accès client en base avec identifiant, mot de passe et expiration":
    "Creates a client access in the database with username, password and expiry",
  "Aucune scène associée à ce compte.": "No scene associated with this account.",
  "Démarrage automatique du tunnel public Cloudflare…":
    "Starting the public Cloudflare tunnel automatically…",
  "Tunnel public prêt. Création de la vue client possible.":
    "Public tunnel ready. Client view creation available.",
  "Lien public invalide : localhost ne marche pas chez un client externe.":
    "Invalid public link: localhost does not work for an external client.",
  "Publication du mesh…": "Publishing mesh…",
  "Publication du nuage de points…": "Publishing point cloud…",
  "Publication des splats (alignement inclus)…": "Publishing splats (alignment included)…",
  "Nuage présent mais fichier source indisponible (chargé avant ce patch ?) : recharge le PLY puis republie.":
    "Point cloud present but source file unavailable (loaded before this patch?): reload the PLY then republish.",
  "Splats présents mais impossibles à exporter : scène publiée sans splats.":
    "Splats present but not exportable: scene published without splats.",

  // --- Divers / statut ---
  "Mesh": "Mesh",
  "SPLATS": "SPLATS",
  "TRIS": "TRIS",
  "FPS": "FPS",
  "XYZ": "XYZ",
  "Auto": "Auto",
  "Profil": "Profile",
  "Activer": "Enable",
  "Désactiver": "Disable",
  "bbox": "bbox",
  "centre": "center",
  "Actif": "Active",
  "ΔX": "ΔX",
  "ΔY": "ΔY",
  "ΔZ": "ΔZ",

  // --- Préfixes de messages dynamiques ---
  "Échec SOR : ": "SOR failed: ",
  "Échec de la capture : ": "Screenshot failed: ",
  "Échec du chargement de la scène : ": "Scene loading failed: ",
  "Échec export GLB : ": "GLB export failed: ",
  "Échec export GS PLY modifié : ": "Modified GS PLY export failed: ",
  "Échec export OBJ MAGO : ": "MAGO OBJ export failed: ",
  "Échec export PLY MAGO : ": "MAGO PLY export failed: ",
  "Échec export ZIP : ": "ZIP export failed: ",
  "Échec filtre distance au mesh : ": "Distance-to-mesh filter failed: ",
  "Erreur pendant la sélection mesh : ": "Error during mesh selection: ",
  "Attribut non sauvegardé en base : ": "Attribute not saved to database: ",
  "Attribut non supprimé : ": "Attribute not deleted: ",

  // --- Chaînes et pavés d'aide complétés après test ---
  "Aucun fichier": "No file",
  "Aucun objet chargé.": "No object loaded.",
  "Aucun objet manipulé": "No object manipulated",
  "Active l’outil puis charge un GLB classifié.": "Enable the tool then load a classified GLB.",
  "Astuce : la touche Suppr supprime la sélection jaune. Ctrl+Z annule la dernière suppression mesh si elle existe.":
    "Tip: the Del key deletes the yellow selection. Ctrl+Z undoes the last mesh deletion if any.",
  "Baisse la résolution de rendu pour naviguer plus fluide. Les données ne sont pas modifiées.":
    "Lower the render resolution for smoother navigation. The data is not modified.",
  "Distance : clique 2 points. Surface : clique les sommets du contour, puis ferme la surface.":
    "Distance: click 2 points. Surface: click the outline vertices, then close the surface.",
  "Le GLB exporte le mesh. Le PLY GS modifié conserve les suppressions et bake déplacement, rotation et échelle. Le ZIP regroupe la scène complète.":
    "GLB exports the mesh. The modified GS PLY keeps deletions and bakes move, rotation and scale. ZIP bundles the whole scene.",
  "Le LOD change la géométrie affichée selon le zoom. En cas de doute, force LOD2 ici pour vérifier qu'il existe.":
    "LOD changes the displayed geometry with zoom. If in doubt, force LOD2 here to check it exists.",
  "Minimum conseillé : 3 paires non alignées. La matrice affichée/exportée est en repère MAGO / CloudCompare / 3DR Z-up. Elle est convertie depuis le repère interne du viewer.":
    "Recommended minimum: 3 non-collinear pairs. The displayed/exported matrix is in the MAGO / CloudCompare / 3DR Z-up frame. It is converted from the viewer's internal frame.",
  "Mode type SuperSplat : isole les splats blancs/clairs, sélectionne au lasso/rectangle/rond/pinceau, vérifie le surlignage jaune, puis supprime les artefacts de contour.":
    "SuperSplat-style mode: isolate white/light splats, select with lasso/rectangle/circle/brush, check the yellow highlight, then delete outline artifacts.",
  "Nettoyage manuel du mesh : sélectionne des triangles au lasso/rectangle/rond/pinceau, vérifie le surlignage jaune, puis supprime.":
    "Manual mesh cleaning: select triangles with lasso/rectangle/circle/brush, check the yellow highlight, then delete.",
  "Quand l’outil est actif, clique une couche ou un objet du maillage pour consulter et modifier ses attributs.":
    "When the tool is active, click a layer or a mesh object to view and edit its attributes.",
  "Style CloudCompare : clique des paires Source → Cible, calcule une matrice 4x4, puis exporte-la pour MAGO pipeline.":
    "CloudCompare style: click Source → Target pairs, compute a 4x4 matrix, then export it for MAGO Pipeline.",
  "Sélection appliquée à tous les LOD. Maj = ajouter · Ctrl = retirer de la sélection.":
    "Selection applied to all LODs. Shift = add · Ctrl = remove from selection.",
  "Sélectionne le mesh ou les splats, puis active Déplacer ou Rotation. Le gizmo apparaît dans la scène.":
    "Select the mesh or the splats, then enable Move or Rotation. The gizmo appears in the scene.",
  "Z-up → Y-up est appliqué par défaut au chargement. Tu peux toujours modifier ou reset chaque calque ici.":
    "Z-up → Y-up is applied by default on load. You can still edit or reset each layer here.",

  // --- Deuxième ratissage après test ---
  "Recadrer": "Refit",
  "Mot de passe": "Password",
  "Aucun mesh chargé.": "No mesh loaded.",
  "Aucun objet chargé à centrer.": "No loaded object to center.",
  "Aucun objet créé à partir de cette sélection.": "No object created from this selection.",
  "Créer objet depuis sélection": "Create object from selection",
  "Annuler dernière suppression ·": "Undo last deletion ·",
  "Faces visibles uniquement (ne pas traverser les murs)":
    "Visible faces only (do not go through walls)",
  "Distance : clique 2 points sur le mesh.": "Distance: click 2 points on the mesh.",
  "Surface : clique chaque sommet du contour sur le mesh, puis “Fermer surface”.":
    "Surface: click each outline vertex on the mesh, then “Close surface”.",
  "Détache les triangles sélectionnés et crée une nouvelle instance dans la même classe. Utile pour séparer deux tables ou objets collés.":
    "Detaches the selected triangles and creates a new instance in the same class. Useful to separate two tables or glued objects.",
  "Isole la zone sélectionnée : invisible, insélectionnable et protégée de la suppression, jusqu'au réaffichage (raccourci H)":
    "Isolates the selected area: invisible, unselectable and protected from deletion, until shown again (shortcut H)",
  "Isole les splats sélectionnés : invisibles, insélectionnables et protégés de la suppression, jusqu'au réaffichage (raccourci H)":
    "Isolates the selected splats: invisible, unselectable and protected from deletion, until shown again (shortcut H)",
  "PLY GS aligné exporté en repère MAGO Z-up : rechargeable tel quel dans le viewer (et lisible dans CloudCompare/3DR), alignement et suppressions cuits dedans.":
    "Aligned GS PLY exported in the MAGO Z-up frame: reloadable as-is in the viewer (and readable in CloudCompare/3DR), with alignment and deletions baked in.",
  "Pour charger une scène tuilée, clique sur + MAGO Tiles et sélectionne le dossier qui contient scene_tiles.json et tiles/.":
    "To load a tiled scene, click + MAGO Tiles and select the folder containing scene_tiles.json and tiles/.",
  "Splats publiés au format d’origine : l’alignement fait dans le viewer ne sera pas visible côté client (recharge un PLY pour le cuire).":
    "Splats published in their original format: the alignment done in the viewer will not be visible on the client side (reload a PLY to bake it).",
  "Sélection active : dessine au clic gauche. Maj = ajouter à la sélection, Ctrl = soustraire. La molette reste disponible pour zoomer.":
    "Selection active: draw with left click. Shift = add to selection, Ctrl = subtract. The wheel is still available for zooming.",
  "Sélection mesh active sur TOUS les LOD : clic gauche pour dessiner, Maj = ajouter, Ctrl = retirer. « Faces visibles uniquement » évite de traverser les murs.":
    "Mesh selection active on ALL LODs: left click to draw, Shift = add, Ctrl = remove. “Visible faces only” avoids going through walls.",
};