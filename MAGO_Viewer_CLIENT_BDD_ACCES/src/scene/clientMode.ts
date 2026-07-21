/**
 * MAGO Viewer · clientMode.ts
 * ===========================
 * Mode client (rendu verrouillé / lien à fournir au client).
 *
 * Le mode est ACTIVÉ si l'une de ces conditions est vraie :
 *   - le serveur a injecté `window.__MAGO_CLIENT__ = true`
 *     (cas du lien signé, non contournable par le client) ;
 *   - l'URL contient ?client=1  (ou ?mode=client).
 *
 * En mode client :
 *   - une classe `client-mode` est posée sur <body> → le CSS (client-mode.css)
 *     masque les outils verrouillés : import, export, transformations, alignement,
 *     édition mesh/splats, déchargement d'objets.
 *   - RESTENT accessibles : navigation, visibilité des couches (masquer plafond,
 *     table…), mesures, enrichissement sémantique et ses outils.
 *   - `isClientMode()` sert de garde côté JS pour neutraliser les raccourcis
 *     destructifs (Suppr, Ctrl+Z) — le masquage CSS seul étant cosmétique.
 *
 * NB sécurité : masquer l'UI suffit pour les outils d'édition, qui sont 100 %
 * locaux (la source est servie en lecture seule). La seule écriture côté serveur
 * est l'enrichissement, à scoper par projet/token côté API (hors de ce module).
 */

declare global {
  interface Window {
    __MAGO_CLIENT__?: boolean;
  }
}

let cached: boolean | null = null;

function resolve(): boolean {
  if (typeof window !== 'undefined' && window.__MAGO_CLIENT__ === true) return true;
  try {
    const p = new URLSearchParams(window.location.search);
    if (p.get('client') === '1') return true;
    if (p.get('mode') === 'client') return true;
  } catch {
    /* pas d'URL exploitable */
  }
  return false;
}

/** Vrai si le viewer tourne en mode client verrouillé. Résultat mis en cache. */
export function isClientMode(): boolean {
  if (cached === null) cached = resolve();
  return cached;
}

/**
 * Pose la classe `client-mode` sur <body>.
 * À appeler une fois au démarrage, après que le DOM existe.
 * Sans appel / hors mode client, l'interface complète reste strictement inchangée.
 */
export function applyClientMode(): void {
  if (!isClientMode()) return;
  document.body.classList.add('client-mode');
  const sub = document.querySelector('.brand-sub');
  if (sub) sub.textContent = '';
}

/**
 * Construit l'URL du lien client à partir de l'URL courante.
 * Utilisé par le bouton « Copier le lien client » (visible en mode complet uniquement).
 */
export function buildClientLink(): string {
  const url = new URL(window.location.href);
  url.searchParams.set('client', '1');
  url.searchParams.delete('mode');
  return url.toString();
}
