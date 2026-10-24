// Shared vocabulary: metrics, periods, the job contract, and the typed
// hypothesis kinds every agent (model-driven or deterministic) speaks.

import { CONTAINER, DATA_WINDOW } from "./sources.ts";

export const CITIES = ["Lagos", "Abuja", "Port Harcourt", "Accra"] as const;
export const CHANNELS = ["retail", "wholesale", "online"] as const;
export const TICKET_CATEGORIES = ["delivery_delay", "product_quality", "out_of_stock", "price_complaint", "billing"] as const;
export const SKU_NAMES: Record<string, string> = {
  "CHIN-250": "Chin-Chin 250g",
  "PLNT-150": "Plantain Chips 150g",
  "PUFF-6PK": "Puff-Puff Mix 6-pack",
  "KOKO-500": "Kokoro Sticks 500g",
  "GROU-200": "Groundnut Brittle 200g",
  "COCO-100": "Coconut Candy 100g",
};

export type MetricKey = "revenue" | "units" | "tickets" | "late_deliveries" | "ad_spend";

export const METRICS: Record<MetricKey, { table: string; expr: string; label: string; unit: string; filters: string[] }> = {
  revenue: { table: "erp_sales", expr: "SUM(revenue_ngn)", label: "revenue", unit: "NGN", filters: ["city", "channel", "sku"] },
  units: { table: "erp_sales", expr: "SUM(units)", label: "units sold", unit: "units", filters: ["city", "channel", "sku"] },
  tickets: { table: "helpdesk", expr: "SUM(tickets)", label: "helpdesk tickets", unit: "tickets", filters: ["city", "category"] },
  late_deliveries: { table: "logistics", expr: "SUM(deliveries_late)", label: "late deliveries", unit: "deliveries", filters: ["city"] },
  ad_spend: { table: "ad_platform", expr: "SUM(spend_ngn)", label: "ad spend", unit: "NGN", filters: ["city"] },
};

export interface Filters {
  city?: string;
  channel?: string;
  sku?: string;
  category?: string;
}

export interface Contract {
  question: string;
  intent: "explain_change" | "lookup" | "out_of_scope";
  metric: MetricKey | null;
  direction: "down" | "up" | "unknown";
  filters: Filters;
  target_month: string;
  baseline_month: string;
  route: "investigate" | "clarify" | "decline";
  risk: { level: "low" | "medium" | "high"; reasons: string[] };
  confidence: number;
  notes: string[];
}

export type HypothesisKind =
  | "driver_breakdown" | "stockout" | "price_change" | "marketing" | "seasonality"
  | "logistics" | "carrier_change" | "ticket_mix" | "channel_shift" | "custom";

export type Verdict = "open" | "supported" | "refuted" | "inconclusive";

export interface Hypothesis {
  id: string;
  kind: HypothesisKind;
  statement: string;
  rationale: string;
  status: Verdict;
  evidence: string[];       // queryIds
  finding?: string;         // what the evidence shows, in one or two sentences
  impactShare?: number;     // estimated share of the change explained (0..1)
  confidence?: number;
  followUp?: string;        // Skeptic's request for the next round
  attempts: number;
}

// ---------------------------------------------------------------- months

export const monthAdd = (ym: string, n: number): string => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
export const inWindow = (ym: string): boolean => ym >= DATA_WINDOW.from && ym <= DATA_WINDOW.to;
export const monthName = (ym: string): string =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

// ---------------------------------------------------------------- SQL helpers

export const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export function whereFor(metric: MetricKey, f: Filters, extra: string[] = []): string {
  const allowed = METRICS[metric].filters;
  const parts = [...extra];
  for (const [k, v] of Object.entries(f)) if (v && allowed.includes(k)) parts.push(`${k} = ${q(v)}`);
  return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
}

export const T = (name: string): string => `${CONTAINER}.${name}`;

export const pct = (a: number, b: number): number | null => (b === 0 ? null : (a - b) / Math.abs(b));
export const fmtPct = (x: number | null): string => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
export const fmtNum = (x: number, unit = ""): string => {
  const abs = Math.abs(x);
  const s = abs >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : abs >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : `${Math.round(x)}`;
  return unit === "NGN" ? `₦${s}` : unit ? `${s} ${unit}` : s;
};
