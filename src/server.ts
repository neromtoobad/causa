// HTTP entry point.
//   POST /run                 run one job and return the JSON result (judges' programmatic path)
//   POST /api/jobs            start a job in the background, returns { run_id }
//   GET  /api/jobs/:id        job status / result
//   GET  /api/jobs/:id/events live trace (server-sent events) for the office view
//   GET  /api/health          provider + data status
//   GET  /api/memory          what the firm remembers (H-MEM)
//   GET  /sources/:name.json  the client's systems, as Zetaris fetches them
//   GET  /                    the office UI (web/dist)

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { config } from "./config.ts";
import { MeterlessProvider } from "./adapters/meterless.ts";
import { ZetarisClient } from "./adapters/zetaris.ts";
import { firmMemory } from "./agents/archivist.ts";
import { AGENTS, runJob, type RunInput, type RunOutput } from "./run.ts";
import { SOURCES } from "./sources.ts";
import type { Trace, TraceEvent } from "./trace.ts";

const app = new Hono();

interface Job {
  id: string;
  question: string;
  status: "running" | "done";
  startedAt: string;
  events: TraceEvent[];
  result?: RunOutput;
  trace?: Trace;
  listeners: Set<(e: TraceEvent | { type: "done"; result: RunOutput }) => void>;
}
const jobs = new Map<string, Job>();

function parseInput(body: unknown): RunInput | null {
  const b = body as Partial<RunInput> & { query?: string };
  const query = b?.input?.query ?? b?.query;
  if (typeof query !== "string" || !query.trim()) return null;
  return { run_id: b.run_id, input: { query: query.slice(0, 1000) }, options: b.options };
}

app.post("/run", async (c) => {
  const req = parseInput(await c.req.json().catch(() => null));
  if (!req) return c.json({ status: "error", error: { type: "BadRequest", message: 'expected {"input":{"query":"..."}}', recoverable: true } }, 400);
  const res = await runJob(req);
  return c.json(res, res.status === "error" ? 500 : 200);
});

app.post("/api/jobs", async (c) => {
  const req = parseInput(await c.req.json().catch(() => null));
  if (!req) return c.json({ error: 'expected {"query":"..."}' }, 400);
  const id = `run-${Date.now().toString(36)}`;
  req.run_id = id;
  const job: Job = { id, question: req.input.query, status: "running", startedAt: new Date().toISOString(), events: [], listeners: new Set() };
  jobs.set(id, job);
  runJob(req, {
    onTrace: (t) => {
      job.trace = t;
      t.subscribe((e) => {
        job.events.push(e);
        for (const l of job.listeners) l(e);
      });
    },
  }).then((result) => {
    job.status = "done";
    job.result = result;
    for (const l of job.listeners) l({ type: "done", result });
  });
  return c.json({ run_id: id });
});

app.get("/api/jobs/:id", (c) => {
  const job = jobs.get(c.req.param("id"));
  if (!job) return c.json({ error: "not found" }, 404);
  return c.json({ id: job.id, question: job.question, status: job.status, startedAt: job.startedAt, events: job.events, result: job.result });
});

app.get("/api/jobs/:id/events", (c) => {
  const job = jobs.get(c.req.param("id"));
  if (!job) return c.json({ error: "not found" }, 404);
  return streamSSE(c, async (stream) => {
    for (const e of job.events) await stream.writeSSE({ event: "trace", data: JSON.stringify(e) });
    if (job.status === "done") {
      await stream.writeSSE({ event: "done", data: JSON.stringify(job.result) });
      return;
    }
    await new Promise<void>((resolve) => {
      const l = (e: TraceEvent | { type: "done"; result: RunOutput }) => {
        if ("type" in e && e.type === "done") {
          stream.writeSSE({ event: "done", data: JSON.stringify(e.result) }).finally(() => {
            job.listeners.delete(l);
            resolve();
          });
        } else stream.writeSSE({ event: "trace", data: JSON.stringify(e) });
      };
      job.listeners.add(l);
      stream.onAbort(() => {
        job.listeners.delete(l);
        resolve();
      });
    });
  });
});

app.get("/api/jobs", (c) =>
  c.json([...jobs.values()].reverse().slice(0, 20).map((j) => ({ id: j.id, question: j.question, status: j.status, startedAt: j.startedAt, headline: j.result?.output.brief?.headline ?? j.result?.output.summary })))
);

app.get("/api/health", async (c) => {
  const provider = new MeterlessProvider();
  const [p, z] = await Promise.all([config.sampleMode ? Promise.resolve({ status: "offline", models: [], detail: "SAMPLE_MODE" }) : provider.status(), new ZetarisClient().ping()]);
  return c.json({
    sample_mode: config.sampleMode,
    provider: { name: "Meterless Nightshift", base_url: provider.baseUrl, status: p.status, models: p.models.slice(0, 30), fast: config.meterless.fastModel, deep: config.meterless.deepModel },
    zetaris: { mode: new ZetarisClient().mode, ok: z.ok, detail: z.detail },
    agents: AGENTS,
  });
});

app.get("/api/memory", (c) => {
  const hm = firmMemory();
  const all = hm.store.all();
  return c.json(all.slice(-50).reverse().map((m) => ({ id: m.id, content: m.content, layer: m.layer, confidence: m.confidence, refs: m.provenance?.refs ?? [] })));
});

app.get("/api/sources", (c) => c.json(SOURCES));

app.get("/sources/:file", (c) => {
  const name = c.req.param("file").replace(/\.json$/, "");
  if (!SOURCES.some((s) => s.name === name)) return c.json({ error: "unknown system" }, 404);
  return c.body(readFileSync(`data/sources/${name}.json`, "utf8"), 200, { "content-type": "application/json" });
});

app.get("/api/examples", (c) => {
  const dir = "input_examples";
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  return c.json(files.map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")).input.query));
});

if (existsSync("web/dist")) {
  app.use("/*", serveStatic({ root: "./web/dist" }));
  app.get("*", serveStatic({ path: "./web/dist/index.html" }));
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[INFO] Causa listening on http://${config.host}:${info.port} (sample_mode=${config.sampleMode})`);
});
