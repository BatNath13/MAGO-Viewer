/**
 * CloudCompare exporte parfois des PLY avec une ligne d'en-tête non standard :
 *   obj_info xxx
 * Certains loaders (Babylon, Three.js) la rejettent ou la décodent mal.
 * Cette fonction prend un File et retourne un nouveau File "propre" sans ces lignes.
 *
 * On ne touche jamais au corps binaire : seul l'en-tête ASCII est réécrit.
 *
 * IMPORTANT (perf) : on ne lit QUE les premiers 64 Ko du fichier pour scanner
 * l'en-tête. L'ancienne version faisait file.arrayBuffer() sur le fichier
 * entier (265 Mo pour un LOD0 RealityScan) juste pour lire quelques lignes,
 * puis le loader relisait tout : le fichier était chargé deux fois en mémoire.
 * Le corps est désormais référencé via file.slice(), sans copie.
 */
export async function cleanPlyHeaderFromFile(file: File): Promise<File> {
  // L'en-tête PLY est toujours en ASCII et tient en quelques Ko.
  // On scanne au maximum 64 Ko pour trouver "end_header".
  const scanLen = Math.min(file.size, 65536);
  const headBuf = await file.slice(0, scanLen).arrayBuffer();
  const headerScan = new TextDecoder('utf-8').decode(headBuf);

  const endIdx = headerScan.indexOf('end_header');
  if (endIdx === -1) {
    // Pas un PLY ou pas un header ASCII reconnaissable → on retourne tel quel.
    return file;
  }

  const newlineAfter = headerScan.indexOf('\n', endIdx);
  if (newlineAfter === -1) return file;
  const bodyStart = newlineAfter + 1;

  const headerStr = headerScan.slice(0, bodyStart);
  const lines = headerStr.split('\n');

  // On retire toutes les lignes commençant par "obj_info"
  const kept = lines.filter((line) => !line.startsWith('obj_info'));
  if (kept.length === lines.length) {
    // Rien à nettoyer
    return file;
  }

  const newHeaderBytes = new TextEncoder().encode(kept.join('\n'));
  // Blob accepte des fragments hétérogènes : le corps binaire est passé en
  // slice paresseuse du fichier d'origine, il n'est jamais dupliqué en RAM.
  return new File([newHeaderBytes, file.slice(bodyStart)], file.name, { type: file.type });
}
