// Planner: turns the contract into a set of competing hypotheses. It starts
// from what the firm already knows (H-MEM recall): hypotheses already ruled
// out for the same scope and period are not re-tested, and confirmed causes
// are re-checked first. With a model available, Nemotron (deep lane) proposes
// and ranks hypotheses, including custom ones outside the playbook.

import type { Brain } from "../brain.ts";
import { METRICS, type Contract, type Hypothesis, type HypothesisKind } from "../domain.ts";
import { KIND_STATEMENTS, PLAYBOOK, testSql, type Premise } from "../playbook.ts";
import { schemaText } from "../sources.ts";
import type { Trace } from "../trace.ts";

const KINDS: HypothesisKind[] = ["driver_breakdown", "stockout", "price_change", "marketing", "seasonality", "logistics", "carrier_change", "ticket_mix", "channel_shift", "custom"];

export interface Recalled {
  id: string;
  content: string;
  relevance: number;
  refs: string[];
}

export async function plan(c: Contract, premise: Premise, recalled: Recalled[], trace: Trace, brain: Brain, round = 1, existing: Hypothesis[] = [], unexplained?: number): Promise<Hypothesis[]> {
  const scopeKey = `${c.metric} ${c.filters.city ?? ""}`.trim();
  const ruledOut = new Set<HypothesisKind>();
  const reusedNotes: string[] = [];
  for (const m of recalled) {
    if (!m.content.includes(`${c.baseline_month}→${c.target_month}`)) continue;
    if (c.filters.city && !m.content.includes(c.filters.city)) continue;
    const kind = KINDS.find((k) => m.content.toLowerCase().includes(KIND_STATEMENTS[k](c).toLowerCase().slice(0, 28)));
    if (kind && m.content.startsWith("RULED OUT")) {
      ruledOut.add(kind);
      reusedNotes.push(`${kind} (memory ${m.id.slice(0, 8)})`);
    }
  }

  const taken = new Set(existing.map((h) => h.kind));
  let proposals: { kind: HypothesisKind; statement: string; rationale: string }[] = [];

  if (brain.online) {
    const reply = await brain.think<{ hypotheses: { kind: string; statement: string; rationale: string }[] }>(
      "Planner", "deep",
      `You are the Planner at Causa, an analyst firm that explains why business metrics move. Propose competing, testable hypotheses for the change below. Prefer these kinds when they fit: ${KINDS.join(", ")}. Use "custom" only for a cause none of them covers and make its statement testable with the schema. Order by how likely each is to explain most of the change. Never repeat a hypothesis the firm already ruled out for this exact scope and period.\n\nData available (via Zetaris):\n${schemaText()}`,
      [
        `Question: ${c.question}`,
        `Metric: ${METRICS[c.metric!].label}${c.filters.city ? `, city ${c.filters.city}` : ""}${c.filters.channel ? `, channel ${c.filters.channel}` : ""}${c.filters.sku ? `, SKU ${c.filters.sku}` : ""}; ${c.baseline_month} → ${c.target_month}`,
        `Measured: ${premise.baseline} → ${premise.target} (${premise.changePct === null ? "n/a" : (premise.changePct * 100).toFixed(1) + "%"})`,
        recalled.length ? `What the firm already knows (H-MEM):\n${recalled.map((m) => `- ${m.content}`).join("\n")}` : "The firm has no prior findings on this.",
        existing.length ? `Already tested this run: ${existing.map((h) => `${h.kind} (${h.status})`).join(", ")}` : "",
        unexplained !== undefined ? `Round ${round}: ${Math.round(unexplained * 100)}% of the change is still unexplained. Propose only NEW hypotheses that could explain the remainder.` : "",
        `Return {"hypotheses":[{"kind":"...","statement":"...","rationale":"..."}]} with 3 to 6 items.`,
      ].filter(Boolean).join("\n\n")
    );
    if (reply?.hypotheses?.length) {
      proposals = reply.hypotheses
        .map((h) => ({ kind: (KINDS.includes(h.kind as HypothesisKind) ? h.kind : "custom") as HypothesisKind, statement: String(h.statement ?? "").slice(0, 240), rationale: String(h.rationale ?? "").slice(0, 300) }))
        .filter((h) => h.statement);
    }
  }

  if (proposals.length && round === 1) {
    // Coverage floor: the model ranks and adds custom ideas, but every standard
    // test for this metric still runs, so a plausible cause is never skipped.
    const have = new Set(proposals.map((p) => p.kind));
    for (const k of PLAYBOOK[c.metric!]) if (!have.has(k)) proposals.push({ kind: k, statement: KIND_STATEMENTS[k](c), rationale: "playbook coverage (not proposed by the model)" });
  }
  if (!proposals.length) {
    // Deterministic planning from the playbook for this metric.
    const kinds = round === 1 ? PLAYBOOK[c.metric!] : PLAYBOOK[c.metric!].filter((k) => !taken.has(k));
    proposals = kinds.map((k) => ({ kind: k, statement: KIND_STATEMENTS[k](c), rationale: `playbook test for ${METRICS[c.metric!].label}` }));
  }

  const hyps: Hypothesis[] = [];
  for (const p of proposals) {
    if (taken.has(p.kind) && p.kind !== "custom") continue;
    if (ruledOut.has(p.kind)) continue;
    if (p.kind !== "custom" && !testSql(p.kind, c)) continue; // untestable for this metric
    taken.add(p.kind);
    hyps.push({ id: `H${existing.length + hyps.length + 1}`, kind: p.kind, statement: p.statement, rationale: p.rationale, status: "open", evidence: [], attempts: 0 });
  }

  trace.log({
    agent_name: "Planner", action: round === 1 ? "plan_hypotheses" : "replan_hypotheses", target_agent: "Investigator", status: "success",
    model: brain.online ? brain.lastModel : undefined,
    input_summary: `${scopeKey} ${c.baseline_month}→${c.target_month}, ${recalled.length} memories${unexplained !== undefined ? `, ${Math.round(unexplained * 100)}% unexplained` : ""}`,
    output_summary: `${hyps.length} hypotheses: ${hyps.map((h) => `${h.id} ${h.kind}`).join(", ")}${reusedNotes.length ? `; skipped as already ruled out in memory: ${reusedNotes.join(", ")}` : ""}`,
    data: { hypotheses: hyps, skippedFromMemory: reusedNotes },
  });
  return hyps;
}
