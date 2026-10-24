// Skeptic: attacks every finding before it reaches the client.
// - Applies the playbook rule to the rows (the numeric reading).
// - With a model available, Nemotron (deep lane) gives its own verdict from
//   the same rows. If the model and the numbers disagree, the Skeptic sends
//   the numbers back and makes the model reconsider once. Disagreements that
//   survive stay "inconclusive" rather than being papered over.
// - Asks for follow-up evidence when a claimed cause is not yet tied to the
//   money (e.g. a stockout claimed without the SKU's sales by channel).

import type { Brain } from "../brain.ts";
import { tableText, type QueryResult } from "../adapters/zetaris.ts";
import { METRICS, fmtPct, type Contract, type Hypothesis, type Verdict } from "../domain.ts";
import { judge, readQuantify, type Premise, type RuleResult } from "../playbook.ts";
import type { Trace } from "../trace.ts";

interface ModelVerdict {
  verdict: Verdict;
  finding: string;
  impact_share?: number;
  confidence?: number;
  follow_up?: string;
}

export class Skeptic {
  constructor(private trace: Trace, private brain: Brain) {}

  challengePremise(c: Contract, p: Premise): string | null {
    if (p.matchesQuestion) return null;
    const note = `The question assumes ${METRICS[c.metric!].label} went ${c.direction}, but the data shows ${p.direction} (${fmtPct(p.changePct)}, ${c.baseline_month}→${c.target_month}).`;
    this.trace.log({ agent_name: "Skeptic", action: "challenge_premise", target_agent: "Planner", status: "needs_revision", input_summary: c.question.slice(0, 120), output_summary: note });
    return note;
  }

  async review(h: Hypothesis, c: Contract, premise: Premise, r: QueryResult, ctx: { breakdown?: QueryResult }): Promise<{ followUp?: { reason: string; sql?: string; request?: string } }> {
    const rule: RuleResult | null = h.kind === "custom" ? null : judge(h.kind, c, premise, r, ctx);
    let final: { verdict: Verdict; finding: string; impactShare?: number; confidence: number } | null = rule ? { verdict: rule.verdict, finding: rule.finding, impactShare: rule.impactShare, confidence: rule.confidence } : null;
    let followUp: { reason: string; sql?: string; request?: string } | undefined = rule?.followUp;
    let model: string | undefined;

    const descriptive = ["driver_breakdown", "ticket_mix", "channel_shift"].includes(h.kind);
    if (this.brain.online && !descriptive) {
      const system = `You are the Skeptic at Causa. Judge one hypothesis strictly from the evidence rows. "supported" only if the rows show it AND it moves in the direction that explains the change; "refuted" if the rows contradict it; "inconclusive" otherwise. Quote numbers from the rows. Estimate impact_share (0-1) of the total change it explains only if the rows allow it. If a supported cause is not yet tied to the metric itself, put the evidence you still need in follow_up.`;
      const user = [
        `Question: ${c.question}`,
        `Change being explained: ${METRICS[c.metric!].label} ${premise.baseline} → ${premise.target} (${fmtPct(premise.changePct)}), ${c.baseline_month}→${c.target_month}`,
        `Hypothesis ${h.id} (${h.kind}): ${h.statement}`,
        `Evidence ${r.queryId} (Zetaris, ${r.source}):\nSQL: ${r.sql}\n${tableText(r, 30)}`,
        ctx.breakdown && ctx.breakdown.queryId !== r.queryId ? `Context: where the change sits (${ctx.breakdown.queryId}):\n${tableText(ctx.breakdown, 20)}\n(A price RISE can cut revenue when volume falls more than price rises; judge from the rows.)` : "",
        rule ? `Numeric reading of the same rows: ${rule.verdict}: ${rule.finding}` : "",
        `Return {"verdict":"supported|refuted|inconclusive","finding":"...","impact_share":0.0,"confidence":0.0,"follow_up":"... or empty"}`,
      ].filter(Boolean).join("\n\n");
      let mv = await this.brain.think<ModelVerdict>("Skeptic", "deep", system, user);
      model = this.brain.lastModel;
      if (mv && rule && mv.verdict !== rule.verdict && rule.confidence >= 0.75 && rule.verdict !== "inconclusive") {
        this.trace.log({
          agent_name: "Skeptic", action: "dispute", status: "needs_revision", model,
          input_summary: `${h.id}: model said ${mv.verdict}, numbers say ${rule.verdict}`,
          output_summary: `asking the model to reconcile with: ${rule.finding.slice(0, 160)}`,
        });
        const again = await this.brain.think<ModelVerdict>("Skeptic", "deep", system, `${user}\n\nYour previous verdict was "${mv.verdict}" (${mv.finding}). The computed numbers say "${rule.verdict}": ${rule.finding}. Re-read the rows and give your final verdict.`);
        if (again) mv = again;
      }
      if (mv) {
        const agree = !rule || mv.verdict === rule.verdict;
        final = {
          verdict: agree ? mv.verdict : "inconclusive",
          finding: agree ? mv.finding || rule?.finding || "" : `Model and numbers disagree. Model: ${mv.finding}. Numbers: ${rule!.finding}`,
          impactShare: rule?.impactShare ?? (typeof mv.impact_share === "number" ? Math.max(0, Math.min(1, mv.impact_share)) : undefined),
          confidence: agree ? Math.min(0.95, Math.max(rule?.confidence ?? 0, Number(mv.confidence ?? 0.6))) : 0.4,
        };
        if (!followUp && mv.follow_up && mv.follow_up.trim().length > 8 && final.verdict === "supported") followUp = { reason: mv.follow_up.trim(), request: mv.follow_up.trim() };
      }
    }

    if (!final) final = { verdict: "inconclusive", finding: "No model available to judge a custom hypothesis.", confidence: 0.3 };
    h.status = final.verdict;
    h.finding = final.finding;
    // Descriptive tests name what they found, so the brief reads as a finding.
    const labels = rule?.facts?.labels as string[] | undefined;
    if (labels?.length && h.status === "supported" && ["driver_breakdown", "ticket_mix", "channel_shift"].includes(h.kind)) {
      const what = h.kind === "ticket_mix" ? `${labels.join(" and ")} tickets` : h.kind === "channel_shift" ? `the ${labels.join(" and ")} channel${labels.length > 1 ? "s" : ""}` : labels.join(" and ");
      h.statement = `Most of the change sits in ${what}`;
    }
    h.impactShare = final.impactShare;
    h.confidence = final.confidence;
    if (!h.evidence.includes(r.queryId)) h.evidence.push(r.queryId);
    if (followUp && h.status === "supported") h.followUp = followUp.reason;
    else followUp = undefined;

    this.trace.log({
      agent_name: "Skeptic", action: "judge", target_agent: followUp ? "Investigator" : "Writer",
      status: followUp ? "needs_revision" : "success", confidence: h.confidence, model,
      input_summary: `${h.id} ${h.kind}: ${h.statement.slice(0, 100)} | evidence ${r.queryId}`,
      output_summary: `${h.status.toUpperCase()}: ${h.finding?.slice(0, 220)}${followUp ? ` | needs more: ${followUp.reason.slice(0, 120)}` : ""}`,
      data: { hypothesis: h.id, kind: h.kind, statement: h.statement, verdict: h.status, finding: h.finding, impactShare: h.impactShare, confidence: h.confidence, rule: rule?.verdict, queryId: r.queryId, evidence: h.evidence, followUp: followUp?.reason },
    });
    return { followUp };
  }

  // A follow-up arrived: does it hold the claim up?
  reviewFollowUp(h: Hypothesis, c: Contract, r: QueryResult): void {
    if (!h.evidence.includes(r.queryId)) h.evidence.push(r.queryId);
    let verdictNote: string;
    if (r.columns.map((x) => x.toLowerCase()).join() === "sku,channel,target,baseline") {
      const q = readQuantify(c, r);
      const holds = h.kind !== "stockout" || q.consistentWithShelfStockout;
      verdictNote = holds ? `Confirmed against sales: ${q.finding}.` : `Sales do not show the expected pattern: ${q.finding}.`;
      if (!holds) {
        h.status = "inconclusive";
        h.confidence = 0.45;
      } else h.confidence = Math.min(0.95, (h.confidence ?? 0.7) + 0.1);
    } else {
      verdictNote = `Follow-up evidence ${r.queryId} reviewed (${r.rowCount} rows).`;
    }
    h.finding = `${h.finding} ${verdictNote}`.trim();
    h.followUp = undefined;
    this.trace.log({
      agent_name: "Skeptic", action: "accept_follow_up", target_agent: "Writer", status: h.status === "supported" ? "success" : "needs_revision", confidence: h.confidence,
      input_summary: `${h.id} follow-up ${r.queryId}`, output_summary: verdictNote.slice(0, 240),
      data: { hypothesis: h.id, kind: h.kind, statement: h.statement, verdict: h.status, finding: h.finding, impactShare: h.impactShare, confidence: h.confidence, queryId: r.queryId, evidence: h.evidence },
    });
  }
}
