// Generates the synthetic "Kòlá Foods" internal systems that Causa's demo
// investigates. SYNTHETIC DATA: a fictional Lagos snack distributor. Seeded,
// so every run produces identical files. Each system is served by Causa at
// /sources/<system>.json and registered in Zetaris as a REST table, the way
// a real organisation's ERP, warehouse, ad platform, price book, helpdesk and
// logistics tools would each sit behind their own API.
//
// Planted, discoverable stories (the agents are never told these):
//  1. Lagos revenue falls sharply in Aug 2026: the Lagos warehouse runs out of
//     the best-selling SKU (CHIN-250) for 13 days, and Plantain Chips get a
//     15% price rise in Lagos on 1 Aug. Marketing spend is flat-to-up and last
//     year's July->August was flat, so "marketing" and "seasonality" are red
//     herrings.
//  2. Abuja helpdesk tickets jump in Sep 2026: a new logistics partner in
//     Abuja from 1 Sep doubles late deliveries; product quality complaints
//     stay flat.
//  3. Accra online revenue grows from Jun 2026: Meta spend in Accra triples
//     and online conversion holds.
// Run: npx tsx scripts/gen-data.ts

import { mkdirSync, writeFileSync } from "node:fs";

let seed = 20261022;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const noise = (pct: number) => 1 + (rand() * 2 - 1) * pct;
const round = (x: number, d = 0) => Math.round(x * 10 ** d) / 10 ** d;

const months: string[] = [];
for (let y = 2025; y <= 2026; y++) for (let m = 1; m <= 12; m++) if (y === 2025 || m <= 9) months.push(`${y}-${String(m).padStart(2, "0")}`);

const cities = [
  { city: "Lagos", weight: 1.0, currency: "NGN" },
  { city: "Abuja", weight: 0.55, currency: "NGN" },
  { city: "Port Harcourt", weight: 0.4, currency: "NGN" },
  { city: "Accra", weight: 0.3, currency: "NGN" },
];
const channels = [
  { channel: "retail", share: 0.55 },
  { channel: "wholesale", share: 0.33 },
  { channel: "online", share: 0.12 },
];
const skus = [
  { sku: "CHIN-250", name: "Chin-Chin 250g", price: 1200, base: 9000 },
  { sku: "PLNT-150", name: "Plantain Chips 150g", price: 900, base: 7000 },
  { sku: "PUFF-6PK", name: "Puff-Puff Mix 6-pack", price: 2500, base: 2600 },
  { sku: "KOKO-500", name: "Kokoro Sticks 500g", price: 1800, base: 3000 },
  { sku: "GROU-200", name: "Groundnut Brittle 200g", price: 700, base: 5200 },
  { sku: "COCO-100", name: "Coconut Candy 100g", price: 500, base: 4800 },
];

// Mild seasonality (December peak), same shape both years; Jul->Aug flat.
const season: Record<string, number> = { "01": 0.92, "02": 0.94, "03": 0.98, "04": 1.0, "05": 1.0, "06": 1.01, "07": 1.02, "08": 1.02, "09": 1.0, "10": 1.03, "11": 1.08, "12": 1.22 };
const growth = (ym: string) => 1 + 0.012 * months.indexOf(ym); // ~1.2% a month underlying growth

// ----- price book -----
const priceBook: { effective_date: string; sku: string; city: string; old_price_ngn: number; new_price_ngn: number; reason: string }[] = [
  { effective_date: "2025-06-01", sku: "GROU-200", city: "ALL", old_price_ngn: 650, new_price_ngn: 700, reason: "Groundnut input cost" },
  { effective_date: "2026-01-15", sku: "COCO-100", city: "ALL", old_price_ngn: 450, new_price_ngn: 500, reason: "Sugar cost pass-through" },
  { effective_date: "2026-08-01", sku: "PLNT-150", city: "Lagos", old_price_ngn: 900, new_price_ngn: 1035, reason: "Plantain supply shortage, Lagos only" },
  { effective_date: "2026-09-01", sku: "KOKO-500", city: "Abuja", old_price_ngn: 1800, new_price_ngn: 1850, reason: "Routine review" },
];
const priceFor = (sku: string, city: string, ym: string): number => {
  const base = skus.find((s) => s.sku === sku)!;
  let p = sku === "GROU-200" ? 650 : sku === "COCO-100" ? 450 : base.price;
  for (const c of priceBook) {
    if (c.sku === sku && (c.city === "ALL" || c.city === city) && c.effective_date.slice(0, 7) <= ym) p = c.new_price_ngn;
  }
  return p;
};

// ----- inventory -----
const inventory: { month: string; city: string; sku: string; opening_stock_units: number; received_units: number; stockout_days: number }[] = [];
const stockoutDays = (city: string, sku: string, ym: string): number => {
  if (city === "Lagos" && sku === "CHIN-250" && ym === "2026-08") return 13;
  if (city === "Lagos" && sku === "CHIN-250" && ym === "2026-09") return 2;
  if (city === "Port Harcourt" && sku === "PUFF-6PK" && ym === "2025-11") return 4;
  return rand() < 0.05 ? 1 : 0;
};

// ----- marketing -----
const marketing: { month: string; city: string; platform: string; spend_ngn: number; impressions: number; clicks: number }[] = [];
const platforms = [
  { platform: "meta", share: 0.45, cpm: 900, ctr: 0.012 },
  { platform: "google", share: 0.25, cpm: 1400, ctr: 0.02 },
  { platform: "radio", share: 0.2, cpm: 300, ctr: 0 },
  { platform: "billboard", share: 0.1, cpm: 150, ctr: 0 },
];
const budgetFor = (city: string, ym: string): number => {
  const c = cities.find((x) => x.city === city)!;
  let b = 6_000_000 * c.weight * growth(ym);
  if (city === "Lagos" && ym >= "2026-07") b *= 1.06; // Lagos spend slightly UP in Aug (red herring)
  return b;
};

// ----- sales -----
const sales: { month: string; city: string; channel: string; sku: string; units: number; unit_price_ngn: number; revenue_ngn: number }[] = [];

for (const ym of months) {
  const mm = ym.slice(5);
  for (const c of cities) {
    // marketing rows
    for (const p of platforms) {
      let spend = budgetFor(c.city, ym) * p.share * noise(0.04);
      if (c.city === "Accra" && p.platform === "meta" && ym >= "2026-06") spend *= 3.1;
      const impressions = Math.round((spend / p.cpm) * 1000 * noise(0.05));
      marketing.push({ month: ym, city: c.city, platform: p.platform, spend_ngn: round(spend), impressions, clicks: Math.round(impressions * p.ctr * noise(0.08)) });
    }
    for (const s of skus) {
      const so = stockoutDays(c.city, s.sku, ym);
      const availability = 1 - so / 31;
      let demand = s.base * c.weight * season[mm] * growth(ym);
      const price = priceFor(s.sku, c.city, ym);
      const basePrice = s.sku === "GROU-200" ? 650 : s.sku === "COCO-100" ? 450 : s.price;
      demand *= Math.pow(price / basePrice, -1.6); // price elasticity
      inventory.push({
        month: ym, city: c.city, sku: s.sku,
        opening_stock_units: Math.round(demand * (so > 5 ? 0.25 : 0.9) * noise(0.05)),
        received_units: Math.round(demand * (so > 5 ? 0.45 : 1.0) * noise(0.05)),
        stockout_days: so,
      });
      for (const ch of channels) {
        let share = ch.share;
        if (c.city === "Accra" && ch.channel === "online" && ym >= "2026-06") share *= 2.4;
        let units = demand * share * availability * noise(0.035);
        // Wholesale buyers stock up ahead of a known shortage less than retail feels it.
        if (c.city === "Lagos" && s.sku === "CHIN-250" && ym === "2026-08" && ch.channel === "wholesale") units *= 1.05;
        units = Math.max(0, Math.round(units));
        sales.push({ month: ym, city: c.city, channel: ch.channel, sku: s.sku, units, unit_price_ngn: price, revenue_ngn: units * price });
      }
    }
  }
}

// ----- logistics -----
const logistics: { month: string; city: string; carrier: string; deliveries_scheduled: number; deliveries_late: number; avg_delay_hours: number }[] = [];
for (const ym of months) {
  for (const c of cities) {
    const carrier = c.city === "Abuja" && ym >= "2026-09" ? "SwiftRoute 3PL" : c.city === "Accra" ? "GhanaLink Freight" : "Kòlá Fleet";
    const scheduled = Math.round(1400 * c.weight * season[ym.slice(5)] * growth(ym) * noise(0.04));
    let lateRate = 0.07 * noise(0.15);
    let delay = 5 * noise(0.2);
    if (carrier === "SwiftRoute 3PL") {
      lateRate = 0.19;
      delay = 14.5;
    }
    if (c.city === "Lagos" && ym === "2026-08") lateRate *= 1.12; // small wobble: not the main cause
    logistics.push({ month: ym, city: c.city, carrier, deliveries_scheduled: scheduled, deliveries_late: Math.round(scheduled * lateRate), avg_delay_hours: round(delay, 1) });
  }
}

// ----- helpdesk -----
const helpdesk: { month: string; city: string; category: string; tickets: number }[] = [];
for (const ym of months) {
  for (const c of cities) {
    const lg = logistics.find((l) => l.month === ym && l.city === c.city)!;
    const soDays = inventory.filter((i) => i.month === ym && i.city === c.city).reduce((a, i) => a + i.stockout_days, 0);
    const lagosPlantainRise = c.city === "Lagos" && ym >= "2026-08";
    const cats: Record<string, number> = {
      delivery_delay: lg.deliveries_late * 0.35,
      product_quality: 30 * c.weight,
      out_of_stock: 8 * c.weight + soDays * 9,
      price_complaint: 12 * c.weight * (lagosPlantainRise ? 2.2 : 1),
      billing: 10 * c.weight,
    };
    for (const [category, v] of Object.entries(cats)) helpdesk.push({ month: ym, city: c.city, category, tickets: Math.max(0, Math.round(v * noise(0.12))) });
  }
}

const catalogRows = skus.map((s) => ({ sku: s.sku, product_name: s.name, category: s.sku === "PUFF-6PK" ? "mix" : "snack", list_price_ngn_2025: s.sku === "GROU-200" ? 650 : s.sku === "COCO-100" ? 450 : s.price }));

mkdirSync("data/sources", { recursive: true });
const write = (name: string, rows: unknown[], description: string) =>
  writeFileSync(`data/sources/${name}.json`, JSON.stringify({ system: name, description, synthetic: true, generated_by: "scripts/gen-data.ts", records: rows }));

write("erp_sales", sales, "ERP: monthly units and revenue by city, channel and SKU");
write("warehouse_inventory", inventory, "Warehouse system: monthly opening stock, receipts and stockout days by city and SKU");
write("ad_platform", marketing, "Marketing: monthly ad spend, impressions and clicks by city and platform");
write("price_book", priceBook, "Price book: list price changes with effective date, SKU, city and reason");
write("helpdesk", helpdesk, "Helpdesk: monthly ticket counts by city and category");
write("logistics", logistics, "Logistics: monthly scheduled vs late deliveries and average delay by city and carrier");
write("product_catalog", catalogRows, "Product master: SKU, name, category and 2025 list price");

console.log(`sales ${sales.length}, inventory ${inventory.length}, marketing ${marketing.length}, price_book ${priceBook.length}, helpdesk ${helpdesk.length}, logistics ${logistics.length}`);
