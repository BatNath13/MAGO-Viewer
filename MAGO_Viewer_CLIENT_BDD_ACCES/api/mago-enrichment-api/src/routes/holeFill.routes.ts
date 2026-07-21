import { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * Rebouchage d'un trou a partir du nuage classifie.
 *
 * Le front possede deja la geometrie du maillage : il extrait la boucle de bord
 * et n'envoie que ses coordonnees monde. Le backend n'a donc jamais besoin du
 * maillage, uniquement du nuage. C'est ce qui garde la requete legere meme sur
 * un objet a 10 M de faces.
 */

const PY = process.env.MAGO_PYTHON ?? "python";
const SCRIPT = process.env.MAGO_HOLEFILL
  ?? join(process.cwd(), "scripts", "hole_fill.py");

interface FillBody {
  /** Boucle de bord en coordonnees MONDE, ordonnee. */
  boundary: [number, number, number][];
  /** Classe de l'objet portant le trou : c'est elle qui ecarte les points
   *  du mobilier situe devant la surface a reboucher. */
  targetClass?: number;
  /** Nuage recale, cote serveur. */
  cloudPath?: string;
  /** Couleurs du bord : teintent les sommets sans mesure (Steiner, interpole). */
  boundaryRgb?: [number, number, number][] | null;
  decim?: number;
  maxPlaneRms?: number;
}

export default async function holeFillRoutes(app: FastifyInstance) {
  app.post<{ Body: FillBody }>("/holes/fill", async (req, reply) => {
    const b = req.body;
    if (!b?.boundary || b.boundary.length < 3) {
      return reply.code(400).send({ error: "Boucle de bord absente ou trop courte." });
    }
    if (b.boundary.length > 200_000) {
      return reply.code(413).send({ error: "Boucle de bord trop longue." });
    }

    const payload = JSON.stringify({
      boundary: b.boundary,
      target_class: b.targetClass ?? null,
      cloud_path: b.cloudPath ?? null,
      boundary_rgb: b.boundaryRgb ?? null,
      decim: b.decim ?? 0.02,
      max_plane_rms: b.maxPlaneRms ?? 0.08,
    });

    const py = spawn(PY, [SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    py.stdout.on("data", (d) => (out += d));
    py.stderr.on("data", (d) => (err += d));
    py.stdin.write(payload);
    py.stdin.end();

    const code: number = await new Promise((res) => py.on("close", res));
    if (code !== 0) {
      app.log.error({ err }, "hole_fill.py a echoue");
      return reply.code(500).send({ error: "Rebouchage echoue.", detail: err.slice(-400) });
    }

    try {
      return JSON.parse(out);
    } catch {
      return reply.code(500).send({ error: "Sortie Python illisible.", detail: out.slice(0, 300) });
    }
  });
}
