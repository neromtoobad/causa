// One job, end to end:
//   Intake (Scout Intent contract) -> CFO quote -> Archivist recall (H-MEM)
//   -> premise check -> investigation rounds (Meterless Markovian: each round
//   is one bounded step; the hypothesis ledger is the carryover)
//   -> Writer brief -> Archivist remember (H-MEM) ; World Model case file
//   updated by every agent throughout.

import { randomUUID } from "node:crypto";
import { Markovian } from "../engines/markovian/src/index.ts";
import { ZetarisClient, type QueryResult } from "./adapters/zetaris.ts";
import { MeterlessProvider } from "./adapters/meterless.ts";
import { Brain } from "./brain.ts";
import { config } from "./config.ts";
import { METRICS, type Contract, type Hypothesis } from "./domain.ts";
import { premiseSql, readPremise, testSql, type Premise } from "./playbook.ts";
import { Archivist } from "./agents/archivist.ts";
import { CFO } from "./agents/cfo.ts";
import { intake, refresh, type ExecutionContract } from "./agents/intake.ts";
import { Investigator } from "./agents/investigator.ts";
import { plan } from "./agents/planner.ts";
import { Skeptic } from "./agents/skeptic.ts";
import { writeBrief, type Brief } from "./agents/writer.ts";
import { Trace } from "./trace.ts";

export interface RunInput {
  run_id?: string;
  input: { query: string };
  options?: { sample_mode?: boolean; max_rounds?: number };
}

export interface RunOutput {
  run_id: string;
  status: "success" | "declined" | "error";
  output: {
    summary: string;
    brief?: Brief;
    recommendations: string[];
    artifacts: { type: string; path: string }[];
    clarification?: { question: string; options: string[] };
  };
  agents: { name: string; role: string }[];
  contract?: Pick<ExecutionContract, "contractId" | "intent" | "risk" | "toolPlan" | "expiresAt" | "registryVersion"> & { lineage: string[] };
  memory: { recalled: number; stored: number };
  engines: Record<string, string>;
  cost: Record<string, unknown>;
  data_sources: Record<string, number>;
  trace_id: string;
  log_file: string;
  execution_time_seconds: number;
  error?: { type: string; message: string; recoverable: boolean };
}

export const AGENTS = [
  { name: "Intake", role: "Scout Intent: classifies the request, guards it, issues the signed execution contract" },
  { name: "CFO", role: "Quotes the job and enforces its budget for model calls, queries, rounds and time" },
  { name: "Archivist", role: "H-MEM firm memory (recall before, remember after) and the World Model case file" },
  { name: "Planner", role: "Proposes competing hypotheses, starting from what the firm already knows" },
  { name: "Investigator", role: "Tests hypotheses with SQL through Zetaris; repairs failing queries" },
  { name: "Skeptic", role: "Judges every finding against the rows, disputes the model when the numbers disagree, demands follow-ups" },
  { name: "Writer", role: "Writes the evidence-linked brief: causes, what was ruled out, what is still unknown" },
];

const DESCRIPTIVE = new Set(["driver_breakdown", "ticket_mix", "channel_shift"]);

export async function runJob(req: RunInput, hooks: { onTrace?: (t: Trace) => void; quiet?: boolean } = {}): Promise<RunOutput> {
  const runId = (req.run_id || `run-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`).replace(/[^A-Za-z0-9_-]/g, "");
  const started = Date.now();
  const trace = new Trace(runId, "logs", hooks.quiet);
  hooks.onTrace?.(trace);
  const sample = req.options?.sample_mode ?? config.sampleMode;
  const cfo = new CFO(trace, { ...config.budget, ...(req.options?.max_rounds ? { maxRounds: req.options.max_rounds } : {}) });
  const brain = new Brain(trace, cfo, sample ? new MeterlessProvider({ token: "" }) : undefined);
  const zetaris = new ZetarisClient(undefined, sample);

  const base = (status: RunOutput["status"], extra: Partial<RunOutput>): RunOutput => ({
    run_id: runId, status,
    output: { summary: "", recommendations: [], artifacts: [] },
    agents: AGENTS, memory: { recalled: 0, stored: 0 },
    engines: { scout_intent: "contract issued", hmem: "-", world_model: "-", markovian: "-" },
    cost: cfo.statement(), data_sources: {},
    trace_id: runId, log_file: trace.file,
    execution_time_seconds: +((Date.now() - started) / 1000).toFixed(1),
    ...extra,
  });

  trace.log({
    agent_name: "System", action: "start_run", status: "info",
    input_summary: req.input.query.slice(0, 200),
    output_summary: `provider ${brain.online ? `Meterless Nightshift (${brain.provider.baseUrl})` : "none: deterministic reasoning"}; data ${zetaris.mode === "live" ? "Zetaris live" : "sample cache + local mirror"}`,
  });

  try {
    // ---------------------------------------------------- Intake
    const { contract: issued, clarification } = await intake(req.input.query, trace, brain, runId);
    let contract = issued;
    const lineage = [contract.contractId];
    const c: Contract = contract.intent.parameters;
    const contractView = () => ({ contractId: contract.contractId, intent: contract.intent, risk: contract.risk, toolPlan: contract.toolPlan, expiresAt: contract.expiresAt, registryVersion: contract.registryVersion, lineage });

    if (c.route === "decline" || !c.metric) {
      return base("declined", {
        output: { summary: `Declined at intake: ${contract.risk.reason ?? "this is not a question the firm can investigate with the client's data"}.`, recommendations: [], artifacts: [{ type: "trace", path: trace.file }] },
        contract: contractView(),
      });
    }
    if (c.route === "clarify") {
      return base("declined", { output: { summary: "The request is too vague to investigate.", recommendations: [], artifacts: [{ type: "trace", path: trace.file }], clarification }, contract: contractView() });
    }

    cfo.quoteJob(c);
    const archivist = new Archivist(trace, runId);
    await archivist.openCase(c);
    const { memories } = archivist.recall(c);

    // ---------------------------------------------------- premise
    const investigator = new Investigator(zetaris, trace, cfo, brain, () => contract);
    const skeptic = new Skeptic(trace, brain);
    const pr = await investigator.query(premiseSql(c), `Measure ${METRICS[c.metric].label} ${c.baseline_month} vs ${c.target_month}`);
    if (!pr) throw Object.assign(new Error("Could not measure the metric: the data source did not answer"), { type: "UpstreamUnavailable" });
    const premise: Premise = readPremise(c, pr);
    trace.log({
      agent_name: "Investigator", action: "measure_change", target_agent: "Planner", status: "success",
      input_summary: `${METRICS[c.metric].label} ${c.baseline_month} vs ${c.target_month}`,
      output_summary: `${premise.baseline} → ${premise.target} (${premise.changePct === null ? "n/a" : (premise.changePct * 100).toFixed(1) + "%"})`,
      data: { premise, metric: METRICS[c.metric].label, unit: METRICS[c.metric].unit, baseline_month: c.baseline_month, target_month: c.target_month, filters: c.filters, queryId: pr.queryId },
    });
    const premiseNote = skeptic.challengePremise(c, premise) ?? undefined;
    if (premise.direction === "flat") {
      trace.log({ agent_name: "Skeptic", action: "flat_change", status: "info", input_summary: `${premise.baseline} → ${premise.target}`, output_summary: "the metric barely moved; investigating anyway but expect weak signals" });
    }

    // ---------------------------------------------------- rounds (Markovian)
    const hyps: Hypothesis[] = [];
    let breakdown: QueryResult | undefined;
    let pendingFollowUps: { h: Hypothesis; sql?: string; request?: string; reason: string }[] = [];
    let replanned = false;

    const unexplained = () => {
      const causal = hyps.filter((h) => h.status === "supported" && !DESCRIPTIVE.has(h.kind));
      return Math.max(0, 1 - causal.reduce((a, h) => a + (h.impactShare ?? 0), 0));
    };

    const testHypothesis = async (h: Hypothesis) => {
      h.attempts++;
      const sql = h.kind === "custom" ? null : testSql(h.kind, c);
      const r = sql ? await investigator.query(sql, `Test ${h.id} ${h.kind}`, { for: "Skeptic" }) : await investigator.authored(`${h.statement} (scope: ${c.filters.city ?? "all cities"}, ${c.baseline_month} vs ${c.target_month})`, `Test ${h.id} custom`, "Skeptic");
      if (!r) {
        h.status = "inconclusive";
        h.finding = "Evidence could not be gathered within budget.";
        return;
      }
      h.evidence.push(r.queryId);
      await archivist.putHypothesis(h, "Investigator");
      const { followUp } = await skeptic.review(h, c, premise, r, { breakdown });
      await archivist.putFinding(h, "Skeptic");
      if (followUp) pendingFollowUps.push({ h, ...followUp });
    };

    const ledger = () => hyps.map((h) => `${h.id} ${h.kind} ${h.status}${h.impactShare !== undefined ? ` ${Math.round(h.impactShare * 100)}%` : ""}`).join("\n");

    const markov = new Markovian({ chunkConfig: { chunkSize: 2000, maxChunks: cfo.quote.maxRounds, carryoverTokens: 256 } });
    const run = await markov.run({
      goal: c.question,
      mode: "ARCHITECT",
      reflect: false,
      stepFn: async ({ step, carryover }) => {
        const round = step + 1;
        contract = refresh(contract); // Scout Intent: refresh the contract per chunk, keep lineage
        lineage.push(contract.contractId);
        if (!cfo.approve("rounds", "Planner")) return { content: `Round ${round}: budget exhausted.\n[TASK_COMPLETE]` };
        trace.log({
          agent_name: "System", action: "round_start", status: "info",
          input_summary: `Markovian step ${round}; carryover ${carryover.length} chars`,
          output_summary: `round ${round}: ${carryover ? carryover.replace(/\n/g, " | ").slice(0, 200) : "fresh start"}`,
          data: { engine: "Markovian", step: round, carryover },
        });

        if (round === 1) {
          hyps.push(...(await plan(c, premise, memories, trace, brain, 1)));
          const bd = hyps.find((h) => DESCRIPTIVE.has(h.kind) && h.kind !== "channel_shift");
          if (bd) {
            await testHypothesis(bd);
            breakdown = bd.evidence.length ? investigator.results.get(bd.evidence[0]) : undefined;
          }
          // Independent hypotheses are tested in parallel; their World Model writes serialize.
          const rest = hyps.filter((h) => h !== bd);
          for (let i = 0; i < rest.length; i += 3) await Promise.all(rest.slice(i, i + 3).map(testHypothesis));
        } else if (pendingFollowUps.length) {
          const batch = pendingFollowUps;
          pendingFollowUps = [];
          for (const f of batch) {
            trace.log({ agent_name: "Skeptic", action: "request_follow_up", target_agent: "Investigator", status: "needs_revision", input_summary: `${f.h.id} ${f.h.kind}`, output_summary: f.reason.slice(0, 200) });
            const r = f.sql ? await investigator.query(f.sql, `Follow-up for ${f.h.id}`, { for: "Skeptic" }) : f.request ? await investigator.authored(f.request, `Follow-up for ${f.h.id}`, "Skeptic") : null;
            if (r) {
              skeptic.reviewFollowUp(f.h, c, r);
              await archivist.putFinding(f.h, "Skeptic");
            }
          }
        } else if (!replanned && unexplained() > 0.35) {
          replanned = true;
          const more = await plan(c, premise, memories, trace, brain, round, hyps, unexplained());
          hyps.push(...more);
          for (const h of more) await testHypothesis(h);
        }

        const done = pendingFollowUps.length === 0 && (replanned || unexplained() <= 0.35 || hyps.every((h) => h.status !== "open"));
        const finished = done && (round > 1 || hyps.filter((h) => h.status === "supported" && !DESCRIPTIVE.has(h.kind)).length > 0 || replanned);
        return { content: `Round ${round} complete.\n<CARRYOVER>${ledger()}</CARRYOVER>${finished ? "\n[TASK_COMPLETE]" : ""}` };
      },
    });

    // ---------------------------------------------------- brief + memory
    const caveats = ["Kòlá Foods is a fictional company; its systems hold synthetic demo data."];
    if (cfo.escalations.length) caveats.push(`The CFO stopped further spend (${cfo.escalations.join(", ")}); the brief uses the evidence gathered up to that point.`);
    const brief = await writeBrief(c, premise, hyps, investigator.results, trace, brain, { premiseNote, caveats });
    const stored = archivist.remember(c, hyps);

    const sources: Record<string, number> = {};
    for (const r of investigator.results.values()) sources[r.source] = (sources[r.source] ?? 0) + 1;

    trace.log({
      agent_name: "System", action: "finish_run", status: "success",
      input_summary: `${run.chunks.length} Markovian steps (${run.status})`,
      output_summary: `${brief.causes.length} causes, ${brief.ruled_out.length} ruled out; ${investigator.results.size} queries; World Model events ${archivist.caseState().events}`,
    });

    return base("success", {
      output: {
        summary: `${brief.headline} ${brief.summary}`.trim(),
        brief,
        recommendations: recommend(c, hyps),
        artifacts: [{ type: "trace", path: trace.file }],
      },
      contract: contractView(),
      memory: { recalled: memories.length, stored: stored.length },
      engines: {
        scout_intent: `contract ${lineage[0].slice(0, 8)} refreshed ${lineage.length - 1}x`,
        hmem: `${memories.length} recalled, ${stored.length} stored`,
        world_model: `${archivist.caseState().events} case-file events`,
        markovian: `${run.chunks.length} bounded steps (${run.status}), ~${run.totalTokensSaved} tokens saved (estimated)`,
      },
      cost: cfo.statement(),
      data_sources: sources,
      execution_time_seconds: +((Date.now() - started) / 1000).toFixed(1),
    });
  } catch (e) {
    const err = e as Error & { type?: string };
    trace.log({ agent_name: "System", action: "run_failed", status: "error", input_summary: req.input.query.slice(0, 120), output_summary: err.message.slice(0, 300) });
    return base("error", { output: { summary: "The run failed before a brief could be written.", recommendations: [], artifacts: [{ type: "trace", path: trace.file }] }, error: { type: err.type ?? err.name ?? "Error", message: err.message, recoverable: true } });
  }
}

function recommend(c: Contract, hyps: Hypothesis[]): string[] {
  const out: string[] = [];
  const city = c.filters.city ?? "the affected cities";
  for (const h of hyps.filter((x) => x.status === "supported")) {
    if (h.kind === "stockout") out.push(`Raise safety stock and reorder points for the stocked-out SKUs in ${city}, and alert the warehouse when cover falls under two weeks.`);
    if (h.kind === "price_change") out.push(`Review the recent price rise in ${city}: compare the margin gained with the volume lost before extending it to other cities.`);
    if (h.kind === "carrier_change" || h.kind === "logistics") out.push(`Hold the logistics partner in ${city} to an on-time SLA and track late deliveries weekly; consider reverting if it does not recover within a month.`);
    if (h.kind === "marketing") out.push(`Keep the ad mix that moved results in ${city} and measure its return per platform before scaling.`);
    if (h.kind === "seasonality") out.push("Plan stock and staffing around the seasonal pattern rather than reacting to it.");
  }
  return [...new Set(out)];
}
