// Intake agent, implemented on the Meterless Scout Intent spec:
//   Sense -> Interpret -> Guard -> Route -> Recommend -> signed ExecutionContract
// Nothing downstream acts on the raw question. The Investigator and every
// other tool-using agent verify the contract (signature, expiry, capability
// scope) before touching Zetaris, H-MEM or the World Model.
//
// Stage 1 (deterministic lexical scan) always runs. Stage 2 (Nemotron via
// Nightshift) only helps bind parameters the rules could not, and never
// overrides the Guard.

import { createHmac, randomUUID } from "node:crypto";
import { DATA_WINDOW } from "../sources.ts";
import { CHANNELS, CITIES, SKU_NAMES, TICKET_CATEGORIES, inWindow, monthAdd, type Contract, type MetricKey } from "../domain.ts";
import type { Brain } from "../brain.ts";
import type { Trace } from "../trace.ts";

// ------------------------------------------------------------ registry

export interface Intent {
  id: string;
  category: string;
  description: string;
  capabilities: string[];
  riskClass: "low" | "medium" | "high";
  triggers: [string, number][]; // weighted trigger phrases (Stage 1 lexical)
  examples: string[];
  version: number;
}

export const REGISTRY_VERSION = 3;
export const POLICY_PACK_VERSION = "causa-policy-1";

export const REGISTRY: Intent[] = [
  {
    id: "analysis.explain_change", category: "analysis", version: 2, riskClass: "low",
    description: "Explain why a business metric moved between two periods, with evidence",
    capabilities: ["memory.recall", "world.case", "data.sql", "memory.store"],
    triggers: [["why", 3], ["drop", 2], ["fell", 2], ["fall", 2], ["decline", 2], ["down", 1], ["rise", 2], ["rose", 2], ["jump", 2], ["spike", 2], ["grow", 2], ["grew", 2], ["increase", 2], ["decrease", 2], ["explain", 2], ["cause", 2], ["what happened", 2], ["dip", 2]],
    examples: ["Why did Lagos revenue fall in August 2026?", "What caused the jump in Abuja tickets in September?"],
  },
  {
    id: "analysis.lookup", category: "analysis", version: 1, riskClass: "low",
    description: "Report the value of a metric for a period",
    capabilities: ["data.sql", "world.case"],
    triggers: [["how much", 3], ["how many", 3], ["what was", 2], ["show", 1], ["total", 2], ["list", 1]],
    examples: ["How much revenue did Accra make in July 2026?"],
  },
  {
    id: "action.change_records", category: "action", version: 1, riskClass: "high",
    description: "Modify, delete or send data (Causa only reads and explains)",
    capabilities: ["data.write", "email.send"],
    triggers: [["delete", 4], ["drop table", 5], ["update", 3], ["insert", 3], ["send", 3], ["email", 3], ["refund", 3], ["transfer", 3], ["change the price", 4], ["set the price", 4]],
    examples: ["Delete last month's sales", "Email the Lagos manager"],
  },
];

const CAPABILITY_TOOLS: Record<string, string> = {
  "memory.recall": "hmem.query",
  "memory.store": "hmem.add",
  "world.case": "worldmodel.case",
  "data.sql": "zetaris.sql",
};

// ------------------------------------------------------------ contract

export interface ExecutionContract {
  contractId: string;
  parentId?: string;
  traceId: string;
  intent: { primary: string; parameters: Contract; confidence: number; alternates: { id: string; score: number }[] };
  risk: { level: "low" | "medium" | "high" | "block"; flags: string[]; redactions: string[]; reason?: string };
  toolPlan: { tool: string; capability: string }[];
  modelProfile: { fast: string; deep: string; provider: "meterless-nightshift" };
  scope: { user: string; surface: string; capabilities: string[]; budget?: Record<string, number> };
  issuedAt: string;
  expiresAt: string;
  registryVersion: number;
  policyPackVersion: string;
  signature: string;
  signedBy: "scout";
}

const SECRET = process.env.CAUSA_CONTRACT_SECRET || `causa-dev-${process.pid}`;
const TTL_MS = 5 * 60 * 1000;

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export function sign(c: Omit<ExecutionContract, "signature">): ExecutionContract {
  const signature = createHmac("sha256", SECRET).update(canonical(c)).digest("hex");
  return { ...c, signature };
}

export function verify(c: ExecutionContract, capability: string, now = Date.now()): { ok: true } | { ok: false; reason: string } {
  const { signature, ...rest } = c;
  const expected = createHmac("sha256", SECRET).update(canonical(rest)).digest("hex");
  if (signature !== expected) return { ok: false, reason: "contract signature invalid (tampered or unsigned)" };
  if (now > Date.parse(c.expiresAt)) return { ok: false, reason: "contract expired" };
  if (c.risk.level === "block") return { ok: false, reason: `contract blocked: ${c.risk.reason}` };
  if (!c.scope.capabilities.includes(capability)) return { ok: false, reason: `capability ${capability} is outside the contract scope` };
  return { ok: true };
}

// Long-running work refreshes the contract per round, keeping lineage.
export function refresh(c: ExecutionContract): ExecutionContract {
  const { signature: _s, ...rest } = c;
  const now = new Date();
  return sign({ ...rest, parentId: c.contractId, contractId: randomUUID(), issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + TTL_MS).toISOString() });
}

// ------------------------------------------------------------ stages

const lower = (s: string) => s.toLowerCase();

export function sense(text: string): { id: string; score: number }[] {
  const t = lower(text);
  const raw = REGISTRY.map((i) => {
    let s = 0;
    for (const [phrase, w] of i.triggers) if (new RegExp(`\\b${phrase}\\b`).test(t)) s += w;
    return { id: i.id, raw: s };
  });
  const total = raw.reduce((a, r) => a + r.raw, 0);
  return raw
    .map((r) => ({ id: r.id, score: total ? +(r.raw / total).toFixed(3) : 0 }))
    .sort((a, b) => b.score - a.score);
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

export function bindMonths(text: string): string[] {
  const t = lower(text);
  const found: { idx: number; ym: string }[] = [];
  for (const m of t.matchAll(/\b(20\d\d)-(0[1-9]|1[0-2])\b/g)) found.push({ idx: m.index!, ym: `${m[1]}-${m[2]}` });
  for (const m of t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?(?:\s+(20\d\d))?\b/g)) {
    if (m[1] === "may" && !m[2] && !/\bmay\s+(?:20\d\d|vs|to|compared)/.test(t.slice(m.index!))) {
      // "may" is also a verb; only bind it when it clearly names a month
      if (!/\b(in|of|for|since|from|to|vs|and|between|during|until|till)\s+may\b/.test(t)) continue;
    }
    const mm = MONTHS[m[1]];
    let year = m[2] ? Number(m[2]) : Number(DATA_WINDOW.to.slice(0, 4));
    let ym = `${year}-${String(mm).padStart(2, "0")}`;
    if (!m[2] && ym > DATA_WINDOW.to) ym = `${year - 1}-${String(mm).padStart(2, "0")}`;
    found.push({ idx: m.index!, ym });
  }
  if (/\blast month\b/.test(t)) found.push({ idx: t.indexOf("last month"), ym: DATA_WINDOW.to });
  return found.sort((a, b) => a.idx - b.idx).map((f) => f.ym).filter((v, i, a) => a.indexOf(v) === i);
}

export function bindMetric(text: string): MetricKey | null {
  const t = lower(text);
  if (/\b(ticket|complain|complaint|helpdesk|support)/.test(t)) return "tickets";
  if (/\b(late deliver|delivery delay|deliveries|on-time|on time|logistic)/.test(t)) return "late_deliveries";
  if (/\b(ad spend|marketing spend|spend on ads|advertis)/.test(t)) return "ad_spend";
  if (/\b(units|volume|quantity)\b/.test(t)) return "units";
  if (/\b(revenue|sales|turnover|income|takings)\b/.test(t)) return "revenue";
  return null;
}

const INJECTION = [/ignore (all |the )?(previous|prior|above) (instructions|prompts)/i, /<\/?system>/i, /\[INST\]/i, /you are now/i, /reveal (your|the) (system )?prompt/i, /api[_ ]?key|password|secret token/i];
const OFF_DOMAIN = /\b(competitor|weather|election|stock price|bitcoin|crypto|exchange rate|rival)\b/i;

export interface IntakeResult {
  contract: ExecutionContract;
  clarification?: { question: string; options: string[] };
}

export async function intake(question: string, trace: Trace, brain: Brain | null, runId: string, user = "client"): Promise<IntakeResult> {
  const text = question.trim().slice(0, 1000);

  // Sense
  const ranked = sense(text);
  let top = ranked[0];
  if (top.score === 0) top = { id: "analysis.explain_change", score: 0.4 }; // GENERAL fallback for a bare question
  const intentDef = REGISTRY.find((i) => i.id === top.id)!;

  // Interpret (Stage 1 rules)
  const months = bindMonths(text).filter(inWindow);
  const city = CITIES.find((c) => lower(text).includes(lower(c)));
  const channel = CHANNELS.find((c) => new RegExp(`\\b${c}\\b`).test(lower(text)));
  const sku = Object.entries(SKU_NAMES).find(([code, name]) => lower(text).includes(lower(code)) || lower(text).includes(lower(name.split(" ").slice(0, -1).join(" "))))?.[0];
  const category = TICKET_CATEGORIES.find((c) => lower(text).includes(c.replace("_", " ")));
  let metric = bindMetric(text);
  const direction: Contract["direction"] = /\b(drop|fell|fall|declin|down|decreas|dip|lower|slump)/i.test(text) ? "down" : /\b(rise|rose|jump|spike|grow|grew|increas|up|higher|surge)/i.test(text) ? "up" : "unknown";
  let target = months.length >= 2 ? months[months.length - 1] : months[0] ?? DATA_WINDOW.to;
  let baseline = months.length >= 2 ? months[0] : monthAdd(target, -1);
  if (baseline > target) [baseline, target] = [target, baseline];
  const notes: string[] = [];
  if (!months.length) notes.push(`no period named; using the latest month in the data (${target}) vs the month before`);

  // Interpret (Stage 2, optional): ask Nemotron to bind what the rules missed.
  if (brain?.online && (!metric || !months.length)) {
    const s2 = await brain.think<{ metric?: string; target_month?: string; baseline_month?: string; city?: string }>(
      "Intake", "fast",
      `You bind parameters for a business-analytics intent. Data covers ${DATA_WINDOW.from} to ${DATA_WINDOW.to}, cities ${CITIES.join(", ")}. Metrics: revenue, units, tickets, late_deliveries, ad_spend. Months are YYYY-MM.`,
      `Question: ${text}\nReturn {"metric": one of the metrics or null, "target_month": "YYYY-MM" or null, "baseline_month": "YYYY-MM" or null, "city": string or null}`
    );
    if (s2) {
      if (!metric && s2.metric && s2.metric in { revenue: 1, units: 1, tickets: 1, late_deliveries: 1, ad_spend: 1 }) metric = s2.metric as MetricKey;
      if (!months.length && s2.target_month && inWindow(s2.target_month)) {
        target = s2.target_month;
        baseline = s2.baseline_month && inWindow(s2.baseline_month) && s2.baseline_month < target ? s2.baseline_month : monthAdd(target, -1);
        notes.pop();
      }
      trace.log({ agent_name: "Intake", action: "stage2_bind", status: "success", model: brain.lastModel, input_summary: "Scout Intent Stage 2 rescoring", output_summary: `metric=${metric} target=${target} baseline=${baseline}` });
    }
  }
  if (!metric && intentDef.category === "analysis") {
    metric = "revenue";
    notes.push("no metric named; assuming revenue");
  }

  // Guard
  const flags: string[] = [];
  let level: ExecutionContract["risk"]["level"] = intentDef.riskClass;
  let reason: string | undefined;
  if (INJECTION.some((re) => re.test(text))) {
    flags.push("injection");
    level = "block";
    reason = "the request tries to change the agents' instructions or extract secrets";
  }
  if (intentDef.riskClass === "high") {
    flags.push("write_action");
    level = "block";
    reason = reason ?? "Causa only reads and explains data; it cannot change records or send messages";
  }
  if (OFF_DOMAIN.test(text)) flags.push("data_outside_estate");
  const redactions: string[] = [];
  if (/\b\d{10,}\b|@[a-z0-9-]+\.[a-z]/i.test(text)) redactions.push("possible personal identifier");
  if (!inWindow(target)) flags.push("period_outside_data");
  if (level !== "block" && flags.length) level = "medium";

  // Route
  const toolPlan = intentDef.capabilities.filter((c) => CAPABILITY_TOOLS[c]).map((c) => ({ capability: c, tool: CAPABILITY_TOOLS[c] }));

  const parameters: Contract = {
    question: text,
    intent: intentDef.id === "analysis.lookup" ? "lookup" : intentDef.category === "analysis" ? "explain_change" : "out_of_scope",
    metric,
    direction,
    filters: { city, channel, sku, category },
    target_month: target,
    baseline_month: baseline,
    route: level === "block" ? "decline" : top.score < 0.4 ? "clarify" : "investigate",
    risk: { level: level === "block" ? "high" : level, reasons: [...flags, ...(reason ? [reason] : [])] },
    confidence: top.score,
    notes,
  };

  const now = new Date();
  const contract = sign({
    contractId: randomUUID(),
    traceId: runId,
    intent: { primary: intentDef.id, parameters, confidence: top.score, alternates: ranked.slice(1).filter((r) => r.score > 0) },
    risk: { level, flags, redactions, reason },
    toolPlan,
    modelProfile: { fast: "lane:fast (Nemotron via Nightshift)", deep: "lane:deep (Nemotron via Nightshift)", provider: "meterless-nightshift" },
    scope: { user, surface: "causa-api", capabilities: level === "block" ? [] : intentDef.capabilities },
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
    registryVersion: REGISTRY_VERSION,
    policyPackVersion: POLICY_PACK_VERSION,
    signedBy: "scout",
  });

  trace.log({
    agent_name: "Intake", action: "issue_contract", target_agent: level === "block" ? undefined : "CFO",
    status: level === "block" ? "needs_revision" : "success", confidence: top.score,
    input_summary: text.slice(0, 160),
    output_summary: level === "block"
      ? `blocked at Guard: ${reason}`
      : `${intentDef.id} (${top.score}); ${metric} ${city ?? "all cities"}${channel ? ` ${channel}` : ""}${sku ? ` ${sku}` : ""} ${baseline}→${target}; risk ${level}${flags.length ? ` [${flags.join(", ")}]` : ""}; signed contract ${contract.contractId.slice(0, 8)}`,
    data: { engine: "Scout Intent", contract: { ...contract, signature: contract.signature.slice(0, 12) + "…" } },
  });

  const clarification = parameters.route === "clarify"
    ? { question: "Which business question should the firm investigate?", options: REGISTRY.filter((i) => i.category === "analysis").map((i) => i.examples[0]) }
    : undefined;
  return { contract, clarification };
}
