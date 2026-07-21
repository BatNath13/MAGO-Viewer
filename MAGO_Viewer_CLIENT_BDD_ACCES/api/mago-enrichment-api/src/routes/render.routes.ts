import { FastifyInstance } from "fastify";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";

interface Session {
  ffmpeg: ChildProcessWithoutNullStreams;
  outPath: string;
  outName: string;
  nextIndex: number;
}

const sessions = new Map<string, Session>();
const OUT_DIR = join(process.cwd(), "public", "renders");

export default async function renderRoutes(app: FastifyInstance) {
  // Le corps des frames est du PNG brut : on le laisse passer en Buffer.
  app.addContentTypeParser(
    "image/png",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body)
  );

  app.post("/render/session", async (req) => {
    const { fps = 30 } = req.body as { fps?: number };
    await mkdir(OUT_DIR, { recursive: true });

    const sessionId = randomUUID();
    const outName = `${sessionId}.mp4`;
    const outPath = join(OUT_DIR, outName);

    // Les PNG arrivent concaténés sur stdin : image2pipe les découpe seul.
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-f", "image2pipe",
      "-framerate", String(fps),
      "-i", "pipe:0",
      "-c:v", "libx264",
      "-preset", "slow",
      "-crf", "16",
      // yuv420p + dimensions paires : sans ça, PowerPoint et QuickTime refusent.
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outPath,
    ]);

    ffmpeg.stderr.on("data", (d) => app.log.debug(d.toString()));

    sessions.set(sessionId, { ffmpeg, outPath, outName, nextIndex: 0 });
    return { sessionId };
  });

  app.post<{ Params: { id: string; index: string } }>(
    "/render/:id/frame/:index",
    async (req, reply) => {
      const session = sessions.get(req.params.id);
      if (!session) return reply.code(404).send({ error: "Session inconnue." });

      const index = Number(req.params.index);
      if (index !== session.nextIndex) {
        // ffmpeg lit un flux séquentiel : une frame dans le désordre décale tout.
        return reply.code(409).send({
          error: `Frame ${index} reçue alors que ${session.nextIndex} était attendue.`,
        });
      }

      const chunk = req.body as Buffer;
      if (!session.ffmpeg.stdin.write(chunk)) {
        await once(session.ffmpeg.stdin, "drain");
      }
      session.nextIndex++;
      return { received: index };
    }
  );

  app.post<{ Params: { id: string } }>("/render/:id/finish", async (req, reply) => {
    const session = sessions.get(req.params.id);
    if (!session) return reply.code(404).send({ error: "Session inconnue." });

    session.ffmpeg.stdin.end();
    const [code] = await once(session.ffmpeg, "close");
    sessions.delete(req.params.id);

    if (code !== 0) {
      return reply.code(500).send({ error: `ffmpeg s'est arrêté au code ${code}.` });
    }
    return { url: `/renders/${session.outName}`, frames: session.nextIndex };
  });
}
