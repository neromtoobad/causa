// Writer: turns the Skeptic-approved findings into the client brief. Every
// cause carries its evidence (query id, SQL, where it ran); ruled-out
// hypotheses are reported too, because "what it wasn't" is half the answer.
// Nemotron writes the headline and summary when available; the structure and
// the numbers always come from the verified findings, never from the model.

import type { Brain } from "../brain.ts";
import type { QueryResult } from "../adapters/zetaris.ts";
import { METRICS, SKU_NAMES, fmtNum, fmtPct, monthName, type Contract, type Hypothesis } from "../domain.ts";
import type { Premise } from "../playbook.ts";
import type { Trace } from "../trace.ts";

export interface Evidence {
  queryId: string;
  sql: string;
  source: string;
  rows: number;
}

export interface Brief {
  headline: string;
  summary: string;
  change: { metric: string; from: number; to: number; changePct: number | null; unit: string; baseline: string; target: string; scope: string };
  causes: { id: string; statement: string; finding: string; share?: number; confidence?: number; evidence: Evidence[] }[];
  ruled_out: { id: string; statement: string; finding: string; evidence: Evidence[] }[];
  unresolved: { id: string; statement: string; finding: string }[];
  explained_share: number; // -1 when a confirmed cause cannot be sized
  premise_note?: string;
  caveats: string[];
  written_by: "model" | "rules";
}

export async function writeBrief(c: Contract, premise: Premise, hyps: Hypothesis[], results: Map<string, QueryResult>, trace: Trace, brain: Brain, extras: { premiseNote?: string; caveats: string[] }): Promise<Brief> {
  const m = METRICS[c.metric!];
  const ev = (h: Hypothesis): Evidence[] => h.evidence.map((id) => results.get(id)).filter(Boolean).map((r) => ({ queryId: r!.queryId, sql: r!.sql, source: r!.source, rows: r!.rowCount }));
  const descriptive = new Set(["driver_breakdown", "ticket_mix", "channel_shift"]);
  const supported = hyps.filter((h) => h.status === "supported");
  const causes = supported
    .sort((a, b) => Number(descriptive.has(a.kind)) - Number(descriptive.has(b.kind)) || (b.impactShare ?? 0) - (a.impactShare ?? 0))
    .map((h) => ({ id: h.id, statement: h.statement, finding: h.finding ?? "", share: h.impactShare, confidence: h.confidence, evidence: ev(h) }));
  const ruled_out = hyps.filter((h) => h.status === "refuted").map((h) => ({ id: h.id, statement: h.statement, finding: h.finding ?? "", evidence: ev(h) }));
  const unresolved = hyps.filter((h) => h.status === "inconclusive" || h.status === "open").map((h) => ({ id: h.id, statement: h.statement, finding: h.finding ?? "not tested within budget" }));
  const causal = supported.filter((h) => !descriptive.has(h.kind));
  const explained = Math.min(1, causal.reduce((a, h) => a + (h.impactShare ?? 0), 0));
  const unquantified = causal.filter((h) => h.impactShare === undefined);
  const scope = [c.filters.city, c.filters.channel, c.filters.sku, c.filters.category].filter(Boolean).join(", ") || "all cities";

  const change = { metric: m.label, from: premise.baseline, to: premise.target, changePct: premise.changePct, unit: m.unit, baseline: c.baseline_month, target: c.target_month, scope };
  const movement = `${m.label} (${scope}) went ${fmtNum(premise.baseline, m.unit)} → ${fmtNum(premise.target, m.unit)} (${fmtPct(premise.changePct)}) from ${monthName(c.baseline_month)} to ${monthName(c.target_month)}`;

  let headline = "";
  let summary = "";
  let writtenBy: Brief["written_by"] = "rules";
  if (brain.online) {
    const reply = await brain.think<{ headline: string; summary: string }>(
      "Writer", "deep",
      "You are the Writer at Causa. Write for a busy business owner: plain words, no jargon, numbers from the findings only. Cite hypothesis ids in brackets like [H2]. Do not add causes that are not in the confirmed list. Mention what was ruled out in one sentence.",
      [
        `Question: ${c.question}`,
        `What happened: ${movement}.`,
        extras.premiseNote ? `Premise check: ${extras.premiseNote}` : "",
        `Confirmed causes:\n${causes.map((x) => `[${x.id}] ${x.statement}: ${x.finding}`).join("\n") || "none"}`,
        `Ruled out:\n${ruled_out.map((x) => `[${x.id}] ${x.statement}: ${x.finding}`).join("\n") || "none"}`,
        `Unresolved:\n${unresolved.map((x) => `[${x.id}] ${x.statement}`).join("\n") || "none"}`,
        `Return {"headline":"one sentence, max 18 words","summary":"3 to 5 sentences"}`,
      ].filter(Boolean).join("\n\n")
    );
    if (reply?.headline && reply.summary) {
      headline = reply.headline.trim();
      summary = reply.summary.trim();
      writtenBy = "model";
    }
  }
  if (!headline) {
    const main = causal.sort((a, b) => (b.impactShare ?? 0) - (a.impactShare ?? 0));
    headline = main.length
      ? `${capitalise([c.filters.channel, c.filters.sku ? SKU_NAMES[c.filters.sku] : "", m.label].filter(Boolean).join(" "))}${c.filters.city ? ` in ${c.filters.city}` : ""} ${premise.direction === "down" ? "fell" : premise.direction === "up" ? "rose" : "held"} ${premise.changePct === null ? "" : `${Math.abs(premise.changePct * 100).toFixed(1)}% `}mainly because ${main.map((h) => lowerFirst(h.statement)).slice(0, 2).join(" and ")}.`
      : `${capitalise(m.label)} moved ${fmtPct(premise.changePct)}; no single cause was confirmed by the data.`;
    summary = [
      `${movement}.`,
      ...main.map((h) => `[${h.id}] ${h.finding}`),
      ruled_out.length ? `Ruled out: ${ruled_out.map((h) => `${lowerFirst(h.statement)} [${h.id}]`).join("; ")}.` : "",
    ].filter(Boolean).join(" ");
  }

  const brief: Brief = {
    headline, summary, change, causes, ruled_out, unresolved,
    explained_share: unquantified.length ? -1 : +explained.toFixed(2),
    premise_note: extras.premiseNote,
    caveats: [
      ...extras.caveats,
      ...(unquantified.length ? [`The size of ${unquantified.map((h) => `[${h.id}]`).join(", ")}'s effect cannot be measured directly from these systems; it is supported by direction and timing, not by a measured share.`] : []),
      ...(explained < 0.7 && causal.length && !unquantified.length ? [`The confirmed causes account for about ${Math.round(explained * 100)}% of the change; the rest is unexplained by the data the firm can see.`] : []),
    ],
    written_by: writtenBy,
  };
  trace.log({
    agent_name: "Writer", action: "write_brief", status: "success", model: writtenBy === "model" ? brain.lastModel : undefined,
    input_summary: `${causes.length} causes, ${ruled_out.length} ruled out, ${unresolved.length} unresolved`,
    output_summary: headline,
  });
  return brief;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s: string) => (s.charAt(0).toLowerCase() + s.slice(1)).replace(/[.\s]+$/, "");
