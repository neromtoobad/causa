// Archivist: the firm's memory and its shared case file.
//
// - Meterless H-MEM: findings from finished investigations are stored as
//   long-term memories with provenance (the Zetaris query ids that proved
//   them). Before planning, the Planner recalls related findings, so a second
//   question about the same business starts from what the firm already knows.
// - Meterless World Model: the live case file every agent reads and writes
//   during a run (the question, the hypotheses, each verdict and the evidence
//   behind it). Its single-writer queue keeps the Investigator's and the
//   Skeptic's concurrent writes from clobbering each other, and its event log
//   drives the office view.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HMEM, type QueryResult as MemoryQuery } from "../../engines/hmem/src/index.ts";
import { WorldModel, type WorldEvent } from "../../engines/world-model/src/index.ts";
import { config } from "../config.ts";
import type { Contract, Hypothesis } from "../domain.ts";
import type { Trace } from "../trace.ts";

let hmemSingleton: HMEM | null = null;
let worldSingleton: WorldModel | null = null;

export function firmMemory(dir = join(config.dataDir, "hmem")): HMEM {
  if (!hmemSingleton) {
    mkdirSync(dir, { recursive: true });
    hmemSingleton = new HMEM({ persistDir: dir, actor: "causa-archivist" });
  }
  return hmemSingleton;
}

export function caseFile(dir = config.dataDir): WorldModel {
  if (!worldSingleton) {
    mkdirSync(dir, { recursive: true });
    worldSingleton = new WorldModel({ namespace: "causa", storage: "local", directory: dir, conflictPolicy: "most-recent-wins" });
  }
  return worldSingleton;
}

// Test hook: fresh, in-memory engines.
export function resetArchives(persist = false, dir?: string): void {
  hmemSingleton = persist && dir ? new HMEM({ persistDir: dir, actor: "causa-archivist" }) : new HMEM({ actor: "causa-archivist" });
  worldSingleton = new WorldModel({ namespace: "causa", storage: "memory", conflictPolicy: "most-recent-wins" });
}

export class Archivist {
  readonly hmem = firmMemory();
  readonly world = caseFile();
  readonly caseId: string;

  constructor(private trace: Trace, private runId: string) {
    this.caseId = `case:${runId}`;
  }

  private src(by: string, url?: string) {
    return { kind: "agent", by, at: new Date(), runId: this.runId, url };
  }

  // ------------------------------------------------------------ H-MEM

  recall(contract: Contract): { context: string; memories: { id: string; content: string; relevance: number; refs: string[] }[] } {
    const query = [contract.question, contract.filters.city, contract.metric, contract.target_month].filter(Boolean).join(" ");
    const res: MemoryQuery = this.hmem.query(query, { topN: 6, threshold: 0.2 });
    const memories = res.memories.map((m) => ({ id: m.memory.id, content: m.memory.content, relevance: +m.relevance.toFixed(3), refs: m.memory.provenance?.refs ?? [] }));
    this.trace.log({
      agent_name: "Archivist", action: "recall_memory", target_agent: "Planner", status: "success",
      input_summary: `H-MEM query: "${query}"`,
      output_summary: memories.length ? `${memories.length} prior findings recalled (${res.trace.strategy}); top: ${memories[0].content.slice(0, 100)}` : "no prior findings for this business question",
      data: { engine: "H-MEM", memories, strategy: res.trace.strategy },
    });
    return { context: res.context, memories };
  }

  remember(contract: Contract, hyps: Hypothesis[]): string[] {
    const ids: string[] = [];
    for (const h of hyps) {
      if (h.status === "open" || !h.finding) continue;
      const verdict = h.status === "supported" ? "CONFIRMED" : h.status === "refuted" ? "RULED OUT" : "UNRESOLVED";
      const scope = [contract.filters.city, contract.filters.channel, contract.filters.sku].filter(Boolean).join(" ");
      const content = `${verdict} (${contract.metric ?? "metric"} ${scope} ${contract.baseline_month}→${contract.target_month}): ${h.statement}. Evidence: ${h.finding}`;
      const rec = this.hmem.add({
        content,
        type: "factual",
        layer: h.status === "supported" ? "long_term" : "working",
        tags: [h.kind, h.status, contract.metric ?? "", contract.filters.city ?? "", contract.target_month].filter(Boolean),
        confidence: h.confidence ?? (h.status === "supported" ? 0.8 : 0.6),
        source: `causa:${this.runId}`,
        provenance: { origin: "plan_completion", learnedAt: Date.now(), label: `Skeptic verdict in ${this.runId}`, refs: h.evidence },
        missionId: this.runId,
      });
      ids.push(rec.id);
    }
    this.trace.log({
      agent_name: "Archivist", action: "store_memory", status: "success",
      input_summary: `${hyps.length} hypotheses with verdicts`,
      output_summary: `${ids.length} findings written to H-MEM with provenance refs to their Zetaris queries`,
      data: { engine: "H-MEM", memoryIds: ids },
    });
    return ids;
  }

  // ------------------------------------------------------------ World Model

  async openCase(contract: Contract): Promise<void> {
    await this.world.upsertContext({ type: "investigation", externalKey: { system: "causa", id: this.runId }, attrs: { question: contract.question, metric: contract.metric, target: contract.target_month, baseline: contract.baseline_month }, source: this.src("Intake") });
    if (contract.filters.city) await this.world.upsertEntity({ type: "city", name: contract.filters.city, source: this.src("Intake") });
  }

  async putHypothesis(h: Hypothesis, by: string): Promise<void> {
    const id = `hypothesis:${this.runId}:${h.id}`;
    const ctx = `investigation:causa:${this.runId}`;
    await this.world.upsertEntity({ type: "hypothesis", externalKey: { system: this.runId, id: h.id }, attrs: { statement: h.statement, kind: h.kind }, source: this.src(by) });
    await this.world.assertFact({ about: externalEntityId(this.runId, h.id), predicate: "status", value: h.status, confidence: h.confidence ?? 0.5, context: ctx, source: this.src(by) });
    for (const qid of h.evidence) {
      await this.world.upsertEntity({ type: "query", externalKey: { system: "zetaris", id: qid }, source: this.src(by) });
      await this.world.relate({ from: externalEntityId(this.runId, h.id), type: "evidenced_by", to: `query:zetaris:${qid}`, context: ctx, source: this.src(by) });
    }
    void id;
  }

  async putFinding(h: Hypothesis, by: string): Promise<void> {
    await this.world.assertFact({ about: externalEntityId(this.runId, h.id), predicate: "finding", value: h.finding ?? "", confidence: h.confidence ?? 0.5, source: this.src(by) });
    await this.world.assertFact({ about: externalEntityId(this.runId, h.id), predicate: "status", value: h.status, confidence: h.confidence ?? 0.5, source: this.src(by) });
  }

  caseState(): { hypotheses: { id: string; statement: string; status: unknown; finding: unknown }[]; events: number } {
    const hyps = this.world.view("graph").query({ type: "hypothesis", where: (e) => e.id.includes(`:${this.runId}:`) });
    return {
      hypotheses: hyps.map((e) => ({ id: e.id, statement: String(e.attrs.statement ?? ""), status: e.attrs.status, finding: e.attrs.finding })),
      events: this.world.events().length,
    };
  }

  onCaseEvent(fn: (e: WorldEvent) => void): () => void {
    return this.world.subscribeEvents(fn);
  }
}

// World Model ids for externally keyed entities: <type>:<system>:<id>
export const externalEntityId = (runId: string, hid: string): string => `hypothesis:${runId}:${hid}`;
