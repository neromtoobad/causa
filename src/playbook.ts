// The firm's playbook: for each typed hypothesis kind, the query that tests it
// against the client's systems and the rule that judges the result. The
// Investigator uses the test queries; the Skeptic applies the rules, either
// as its whole judgement (no model available) or as a numeric second opinion
// it must reconcile with the model's verdict.

import type { QueryResult } from "./adapters/zetaris.ts";
import { METRICS, SKU_NAMES, T, fmtNum, fmtPct, monthAdd, inWindow, pct, q, whereFor, type Contract, type HypothesisKind, type MetricKey, type Verdict } from "./domain.ts";

export interface RuleResult {
  verdict: Verdict;
  finding: string;
  impactShare?: number;
  confidence: number;
  followUp?: { reason: string; sql: string };
  facts?: Record<string, unknown>;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const col = (r: QueryResult, name: string): number => r.columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
const rowsBy = (r: QueryResult, key: string) => {
  const k = col(r, key);
  return new Map(r.rows.map((row) => [String(row[k]), row]));
};
const sumCol = (r: QueryResult, name: string): number => {
  const i = col(r, name);
  return r.rows.reduce((a, row) => a + num(row[i]), 0);
};

export const pair = (c: Contract) => `month IN (${q(c.baseline_month)}, ${q(c.target_month)})`;
const tb = (c: Contract, expr: string) =>
  `SUM(CASE WHEN month = ${q(c.target_month)} THEN ${expr} ELSE 0 END) AS target, SUM(CASE WHEN month = ${q(c.baseline_month)} THEN ${expr} ELSE 0 END) AS baseline`;
const metricInner = (m: MetricKey) => METRICS[m].expr.replace(/^SUM\((.*)\)$/, "$1");

// ------------------------------------------------------------ premise

export function premiseSql(c: Contract): string {
  const m = METRICS[c.metric!];
  return `SELECT month, ${m.expr} AS value FROM ${T(m.table)} ${whereFor(c.metric!, c.filters, [pair(c)])} GROUP BY month ORDER BY month`;
}

export interface Premise {
  target: number;
  baseline: number;
  change: number;
  changePct: number | null;
  direction: "down" | "up" | "flat";
  matchesQuestion: boolean;
}

export function readPremise(c: Contract, r: QueryResult): Premise {
  const byMonth = rowsBy(r, "month");
  const vi = col(r, "value");
  const target = num(byMonth.get(c.target_month)?.[vi]);
  const baseline = num(byMonth.get(c.baseline_month)?.[vi]);
  const changePct = pct(target, baseline);
  const direction = changePct === null || Math.abs(changePct) < 0.02 ? "flat" : changePct < 0 ? "down" : "up";
  return { target, baseline, change: target - baseline, changePct, direction, matchesQuestion: c.direction === "unknown" || c.direction === direction };
}

// ------------------------------------------------------------ tests

export function testSql(kind: HypothesisKind, c: Contract): string | null {
  const m = c.metric!;
  const city = c.filters.city ? [`city = ${q(c.filters.city)}`] : [];
  const sales = m === "revenue" || m === "units";
  switch (kind) {
    case "driver_breakdown":
      if (sales) return `SELECT sku, ${tb(c, metricInner(m))} FROM ${T("erp_sales")} ${whereFor(m, c.filters, [pair(c)])} GROUP BY sku ORDER BY SUM(CASE WHEN month = ${q(c.target_month)} THEN ${metricInner(m)} ELSE 0 END) - SUM(CASE WHEN month = ${q(c.baseline_month)} THEN ${metricInner(m)} ELSE 0 END)`;
      if (m === "ad_spend") return `SELECT platform, ${tb(c, "spend_ngn")} FROM ${T("ad_platform")} ${whereFor(m, c.filters, [pair(c)])} GROUP BY platform ORDER BY platform`;
      if (m === "late_deliveries") return `SELECT carrier, ${tb(c, "deliveries_late")} FROM ${T("logistics")} ${whereFor(m, c.filters, [pair(c)])} GROUP BY carrier ORDER BY carrier`;
      return null;
    case "ticket_mix":
      return `SELECT category, ${tb(c, "tickets")} FROM ${T("helpdesk")} ${whereFor("tickets", { city: c.filters.city }, [pair(c)])} GROUP BY category ORDER BY category`;
    case "channel_shift":
      if (!sales) return null;
      return `SELECT channel, ${tb(c, metricInner(m))} FROM ${T("erp_sales")} ${whereFor(m, { city: c.filters.city, sku: c.filters.sku }, [pair(c)])} GROUP BY channel ORDER BY channel`;
    case "stockout":
      return `SELECT sku, ${tb(c, "stockout_days")} FROM ${T("warehouse_inventory")} WHERE ${[...city, pair(c)].join(" AND ")} GROUP BY sku ORDER BY sku`;
    case "price_change":
      return `SELECT effective_date, sku, city, old_price_ngn, new_price_ngn, reason FROM ${T("price_book")} WHERE effective_date > ${q(c.baseline_month + "-01")} AND effective_date <= ${q(c.target_month + "-31")}${c.filters.city ? ` AND city IN (${q(c.filters.city)}, 'ALL')` : ""} ORDER BY effective_date`;
    case "marketing":
      return `SELECT platform, ${tb(c, "spend_ngn")} FROM ${T("ad_platform")} WHERE ${[...city, pair(c)].join(" AND ")} GROUP BY platform ORDER BY platform`;
    case "seasonality": {
      const pb = monthAdd(c.baseline_month, -12), pt = monthAdd(c.target_month, -12);
      if (!inWindow(pb)) return null;
      const mm = METRICS[m];
      return `SELECT month, ${mm.expr} AS value FROM ${T(mm.table)} ${whereFor(m, c.filters, [`month IN (${q(pb)}, ${q(pt)})`])} GROUP BY month ORDER BY month`;
    }
    case "logistics":
    case "carrier_change":
      return `SELECT month, carrier, SUM(deliveries_scheduled) AS scheduled, SUM(deliveries_late) AS late, AVG(avg_delay_hours) AS delay_hours FROM ${T("logistics")} WHERE ${[...city, pair(c)].join(" AND ")} GROUP BY month, carrier ORDER BY month`;
    default:
      return null;
  }
}

// Follow-up the Skeptic asks for when a supply-side cause is claimed for a
// sales change: show the affected SKU's sales by channel, so the claim is tied
// to the money rather than inferred.
export function quantifySql(c: Contract, skus: string[]): string {
  const m = c.metric === "units" ? "units" : "revenue_ngn";
  return `SELECT sku, channel, ${tb(c, m)} FROM ${T("erp_sales")} WHERE ${[c.filters.city ? `city = ${q(c.filters.city)}` : "", `sku IN (${skus.map(q).join(", ")})`, pair(c)].filter(Boolean).join(" AND ")} GROUP BY sku, channel ORDER BY sku, channel`;
}

// ------------------------------------------------------------ rules

export function judge(kind: HypothesisKind, c: Contract, premise: Premise, r: QueryResult, ctx: { breakdown?: QueryResult } = {}): RuleResult {
  const unit = METRICS[c.metric!].unit;
  const total = premise.change;
  const want = premise.direction; // what we are explaining
  const share = (delta: number) => (total === 0 ? 0 : Math.max(0, Math.min(1, delta / total)));
  // For "bad" metrics (tickets, late deliveries) a rise is the adverse event;
  // for sales a fall is. Supply and price causes must line up with it.
  const badMetric = c.metric === "tickets" || c.metric === "late_deliveries";
  const adverse = badMetric ? want === "up" : want === "down";
  const ticketShare = (category: string): number | undefined => {
    const b = ctx.breakdown;
    if (!b || col(b, "category") === -1) return undefined;
    const row = b.rows.find((r0) => String(r0[col(b, "category")]) === category);
    return row ? share(num(row[col(b, "target")]) - num(row[col(b, "baseline")])) : 0;
  };

  switch (kind) {
    case "driver_breakdown":
    case "ticket_mix":
    case "channel_shift": {
      const keyName = r.columns[0];
      const deltas = r.rows.map((row) => ({ key: String(row[0]), label: SKU_NAMES[String(row[0])] ? `${SKU_NAMES[String(row[0])]} (${row[0]})` : String(row[0]), delta: num(row[col(r, "target")]) - num(row[col(r, "baseline")]) }));
      deltas.sort((a, b) => (want === "down" ? a.delta - b.delta : b.delta - a.delta));
      const top = deltas.filter((d) => share(d.delta) >= 0.15).slice(0, 3);
      if (!top.length) return { verdict: "inconclusive", finding: `No single ${keyName} drives the change; it is spread thinly.`, confidence: 0.5 };
      const parts = top.map((d) => `${d.label} ${fmtNum(d.delta, unit)} (${Math.round(share(d.delta) * 100)}% of the net change)`);
      const offset = deltas.filter((d) => Math.sign(d.delta) !== Math.sign(total) && Math.abs(d.delta) > 0);
      return {
        verdict: "supported",
        finding: `The change is concentrated in: ${parts.join("; ")}.${offset.length ? ` Partly offset by ${offset.slice(0, 2).map((d) => `${d.label} ${fmtNum(d.delta, unit)}`).join(", ")}.` : ""}`,
        impactShare: Math.min(1, top.reduce((a, d) => a + share(d.delta), 0)),
        confidence: 0.9,
        facts: { top: top.map((d) => d.key), labels: top.map((d) => d.label.replace(/_/g, " ")) },
      };
    }
    case "stockout": {
      const hit = r.rows
        .map((row) => ({ sku: String(row[0]), target: num(row[col(r, "target")]), baseline: num(row[col(r, "baseline")]) }))
        .filter((x) => (adverse ? x.target >= 5 && x.target > x.baseline + 2 : x.baseline >= 5 && x.baseline > x.target + 2));
      if (!hit.length) return { verdict: "refuted", finding: `No meaningful stockouts${c.filters.city ? ` in ${c.filters.city}` : ""}: no SKU was out of stock 5+ days in ${adverse ? c.target_month : c.baseline_month}.`, confidence: 0.85 };
      const lost = badMetric ? ticketShare("out_of_stock") : impactFor(ctx.breakdown, hit.map((h) => h.sku), share);
      return {
        verdict: "supported",
        finding: hit.map((h) => `${h.sku} was out of stock ${h.target} days in ${c.target_month} (vs ${h.baseline} in ${c.baseline_month})`).join("; ") + (lost !== undefined ? `; those SKUs account for ${Math.round(lost * 100)}% of the change.` : "."),
        impactShare: lost,
        confidence: lost !== undefined ? 0.8 : 0.65,
        followUp: badMetric ? undefined : { reason: `Tie the stockout to sales: did ${hit.map((h) => h.sku).join(", ")} fall in the channels a shelf stockout would hit?`, sql: quantifySql(c, hit.map((h) => h.sku)) },
        facts: { skus: hit.map((h) => h.sku) },
      };
    }
    case "price_change": {
      if (!r.rows.length) return { verdict: "refuted", finding: `No list price changed between ${c.baseline_month} and ${c.target_month}${c.filters.city ? ` for ${c.filters.city}` : ""}.`, confidence: 0.9 };
      const changes = r.rows.map((row) => ({ date: String(row[0]), sku: String(row[1]), city: String(row[2]), old: num(row[3]), next: num(row[4]), reason: String(row[5]) }));
      const consistent = changes.filter((x) => (adverse ? x.next > x.old : x.next < x.old));
      if (!consistent.length) return { verdict: "refuted", finding: `Prices moved (${changes.map((x) => `${x.sku} ${fmtPct(pct(x.next, x.old))}`).join(", ")}) but in the wrong direction to explain a ${want === "down" ? "fall" : "rise"}.`, confidence: 0.7 };
      const biggest = Math.max(...consistent.map((x) => Math.abs(pct(x.next, x.old) ?? 0)));
      if (badMetric) {
        const pcShare = ticketShare("price_complaint") ?? 0;
        if (biggest < 0.08 || pcShare < 0.1)
          return { verdict: "refuted", finding: `A price change happened (${consistent.map((x) => `${x.sku} ${fmtPct(pct(x.next, x.old))} from ${x.date}`).join(", ")}) but it is small and price complaints carry only ${Math.round(pcShare * 100)}% of the rise in tickets.`, confidence: 0.75 };
      }
      if (biggest < 0.04) return { verdict: "refuted", finding: `Only a minor price adjustment (${consistent.map((x) => `${x.sku} ${fmtPct(pct(x.next, x.old))}`).join(", ")}), too small to move demand materially.`, confidence: 0.7 };
      const lost = badMetric ? ticketShare("price_complaint") : impactFor(ctx.breakdown, consistent.map((x) => x.sku), share);
      // The decisive fact for "a price rise cut revenue": revenue fell even though
      // the price went up, so volume must have fallen by more than the price rose.
      const volumeNotes: string[] = [];
      const bd = ctx.breakdown;
      if (!badMetric && bd && col(bd, "sku") !== -1) {
        for (const x of consistent) {
          const row = bd.rows.find((r0) => String(r0[col(bd, "sku")]) === x.sku);
          if (!row) continue;
          const revCh = pct(num(row[col(bd, "target")]), num(row[col(bd, "baseline")]));
          const priceCh = pct(x.next, x.old);
          if (revCh === null || priceCh === null) continue;
          const volCh = (1 + revCh) / (1 + priceCh) - 1;
          volumeNotes.push(`${x.sku} revenue ${fmtPct(revCh)} despite a ${fmtPct(priceCh)} price, so units fell about ${fmtPct(volCh)}`);
        }
      }
      return {
        verdict: "supported",
        finding: consistent.map((x) => `${x.sku} list price ${fmtNum(x.old, "NGN")}→${fmtNum(x.next, "NGN")} (${fmtPct(pct(x.next, x.old))}) from ${x.date} in ${x.city} ("${x.reason}")`).join("; ") + (volumeNotes.length ? `; ${volumeNotes.join("; ")}` : "") + (lost !== undefined ? `; affected SKUs account for ${Math.round(lost * 100)}% of the change.` : "."),
        impactShare: lost,
        confidence: 0.75,
        followUp: lost === undefined || badMetric ? undefined : { reason: `Check the volume response to the price change on ${consistent.map((x) => x.sku).join(", ")}.`, sql: quantifySql(c, consistent.map((x) => x.sku)) },
        facts: { skus: consistent.map((x) => x.sku) },
      };
    }
    case "marketing": {
      const t = sumCol(r, "target"), b = sumCol(r, "baseline");
      const ch = pct(t, b);
      const byPlat = r.rows.map((row) => `${row[0]} ${fmtPct(pct(num(row[col(r, "target")]), num(row[col(r, "baseline")])))}`).join(", ");
      if (ch === null) return { verdict: "inconclusive", finding: "No ad spend recorded for the period.", confidence: 0.4 };
      const aligned = want === "down" ? ch < -0.05 : ch > 0.1;
      if (!aligned) return { verdict: "refuted", finding: `Ad spend went ${fmtPct(ch)} (${fmtNum(b, "NGN")}→${fmtNum(t, "NGN")}; ${byPlat}), which cannot explain a ${want === "down" ? "fall" : "rise"} in ${METRICS[c.metric!].label}.`, confidence: 0.8 };
      return { verdict: "supported", finding: `Ad spend moved ${fmtPct(ch)} (${fmtNum(b, "NGN")}→${fmtNum(t, "NGN")}; by platform: ${byPlat}), in the same direction as ${METRICS[c.metric!].label}.`, confidence: 0.6 };
    }
    case "seasonality": {
      const months = r.rows.map((row) => ({ m: String(row[0]), v: num(row[1]) })).sort((a, b) => a.m.localeCompare(b.m));
      if (months.length < 2) return { verdict: "inconclusive", finding: "Not enough history for a year-ago comparison.", confidence: 0.4 };
      const prior = pct(months[1].v, months[0].v);
      const cur = premise.changePct ?? 0;
      if (Math.abs(cur) < 0.02) return { verdict: "inconclusive", finding: `The metric barely moved (${fmtPct(cur)}); a seasonal comparison (${fmtPct(prior)} a year earlier) cannot separate anything.`, confidence: 0.4 };
      if (prior !== null && Math.sign(prior) === Math.sign(cur) && Math.abs(prior) >= 0.5 * Math.abs(cur))
        return { verdict: "supported", finding: `The same months a year earlier moved ${fmtPct(prior)} (vs ${fmtPct(cur)} now), so much of this is seasonal.`, impactShare: Math.min(1, Math.abs(prior / cur)), confidence: 0.7 };
      return { verdict: "refuted", finding: `A year earlier the same months moved ${fmtPct(prior)}, against ${fmtPct(cur)} now: this is not the normal seasonal pattern.`, confidence: 0.85 };
    }
    case "logistics":
    case "carrier_change": {
      const rows = r.rows.map((row) => ({ month: String(row[0]), carrier: String(row[1]), scheduled: num(row[2]), late: num(row[3]), delay: num(row[4]) }));
      const agg = (m: string) => rows.filter((x) => x.month === m).reduce((a, x) => ({ s: a.s + x.scheduled, l: a.l + x.late, carriers: [...a.carriers, x.carrier], delay: Math.max(a.delay, x.delay) }), { s: 0, l: 0, carriers: [] as string[], delay: 0 });
      const T0 = agg(c.target_month), B0 = agg(c.baseline_month);
      const rt = T0.s ? T0.l / T0.s : 0, rb = B0.s ? B0.l / B0.s : 0;
      const rel = rb ? (rt - rb) / rb : 0;
      const carrierChanged = T0.carriers.join() !== B0.carriers.join();
      const detail = `late-delivery rate ${(rb * 100).toFixed(1)}%→${(rt * 100).toFixed(1)}%, avg delay up to ${T0.delay.toFixed(1)}h${carrierChanged ? `; carrier changed from ${B0.carriers.join("/")} to ${T0.carriers.join("/")}` : ""}`;
      const salesMetric = c.metric === "revenue" || c.metric === "units";
      if ((want === "up" && c.metric !== "revenue" && rel > 0.4) || (want === "down" && salesMetric && rel > 0.6))
        return { verdict: "supported", finding: `Deliveries got much worse: ${detail}.` + (c.metric === "tickets" && ticketShare("delivery_delay") !== undefined ? ` Delivery-delay tickets carry ${Math.round((ticketShare("delivery_delay") ?? 0) * 100)}% of the rise.` : ""), impactShare: c.metric === "tickets" ? ticketShare("delivery_delay") : c.metric === "late_deliveries" ? 0.9 : undefined, confidence: carrierChanged ? 0.85 : 0.7 };
      if (Math.abs(rel) > 0.1) return { verdict: "inconclusive", finding: `Deliveries moved somewhat (${detail}), too little to be the main cause.`, impactShare: 0.05, confidence: 0.55 };
      return { verdict: "refuted", finding: `Deliveries were steady: ${detail}.`, confidence: 0.8 };
    }
    default:
      return { verdict: "inconclusive", finding: "No rule for this hypothesis kind; needs the model's judgement.", confidence: 0.3 };
  }
}

// Share of the total change carried by the given SKUs, from the driver breakdown.
function impactFor(breakdown: QueryResult | undefined, skus: string[], share: (d: number) => number): number | undefined {
  if (!breakdown || col(breakdown, "sku") === -1) return undefined;
  const ti = col(breakdown, "target"), bi = col(breakdown, "baseline"), si = col(breakdown, "sku");
  const d = breakdown.rows.filter((row) => skus.includes(String(row[si]))).reduce((a, row) => a + num(row[ti]) - num(row[bi]), 0);
  return share(d);
}

// Reading the Skeptic's quantify follow-up: which channels moved for the SKUs.
export function readQuantify(c: Contract, r: QueryResult): { finding: string; consistentWithShelfStockout: boolean } {
  const rows = r.rows.map((row) => ({ sku: String(row[0]), channel: String(row[1]), t: num(row[2]), b: num(row[3]) }));
  const unit = c.metric === "units" ? "units" : "NGN";
  const lines = rows.map((x) => `${x.sku} ${x.channel} ${fmtPct(pct(x.t, x.b))} (${fmtNum(x.t - x.b, unit)})`);
  const retail = rows.filter((x) => x.channel === "retail").reduce((a, x) => a + (x.t - x.b) / (x.b || 1), 0);
  const wholesale = rows.filter((x) => x.channel === "wholesale").reduce((a, x) => a + (x.t - x.b) / (x.b || 1), 0);
  return { finding: lines.join("; "), consistentWithShelfStockout: retail < wholesale };
}

export const PLAYBOOK: Record<MetricKey, HypothesisKind[]> = {
  revenue: ["driver_breakdown", "stockout", "price_change", "marketing", "seasonality", "channel_shift", "logistics"],
  units: ["driver_breakdown", "stockout", "price_change", "marketing", "seasonality", "channel_shift"],
  tickets: ["ticket_mix", "logistics", "stockout", "price_change", "seasonality"],
  late_deliveries: ["carrier_change", "driver_breakdown", "seasonality"],
  ad_spend: ["driver_breakdown", "seasonality"],
};

export const KIND_STATEMENTS: Record<HypothesisKind, (c: Contract) => string> = {
  driver_breakdown: (c) => `The change is concentrated in a few ${c.metric === "ad_spend" ? "platforms" : c.metric === "late_deliveries" ? "carriers" : "products"}`,
  ticket_mix: () => "One complaint category drives the change in tickets",
  channel_shift: () => "One sales channel drives the change",
  stockout: (c) => `Warehouse stockouts${c.filters.city ? ` in ${c.filters.city}` : ""} cut what could be sold`,
  price_change: () => "A list price change moved demand",
  marketing: () => "A change in ad spend moved demand",
  seasonality: () => "This is the normal seasonal pattern for these months",
  logistics: () => "Delivery problems drove the change",
  carrier_change: () => "A logistics carrier change drove the change",
  custom: () => "Custom hypothesis",
};
