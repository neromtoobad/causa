// The client's data estate, as Causa sees it through Zetaris. One definition
// drives three things: the Zetaris registration DDL (scripts/zetaris-setup.ts),
// the local sample-mode mirror (src/adapters/mirror.ts), and the schema the
// Planner and Investigator reason over.

export interface Column {
  name: string;
  type: "STRING" | "BIGINT" | "DOUBLE";
  desc: string;
}

export interface SourceTable {
  name: string;   // view name inside the container: kola.<name>
  system: string; // the "internal system" it comes from
  desc: string;
  columns: Column[];
}

export const CONTAINER = "kola";
export const LIGHTNING_DB = "KOLA_SYSTEMS";

export const SOURCES: SourceTable[] = [
  {
    name: "erp_sales", system: "ERP", desc: "Monthly units and revenue by city, channel and SKU",
    columns: [
      { name: "month", type: "STRING", desc: "YYYY-MM" },
      { name: "city", type: "STRING", desc: "Lagos | Abuja | Port Harcourt | Accra" },
      { name: "channel", type: "STRING", desc: "retail | wholesale | online" },
      { name: "sku", type: "STRING", desc: "product code, join to product_catalog.sku" },
      { name: "units", type: "BIGINT", desc: "units sold" },
      { name: "unit_price_ngn", type: "DOUBLE", desc: "list price that month (NGN)" },
      { name: "revenue_ngn", type: "DOUBLE", desc: "units * unit_price_ngn" },
    ],
  },
  {
    name: "warehouse_inventory", system: "Warehouse", desc: "Monthly opening stock, receipts and stockout days by city and SKU",
    columns: [
      { name: "month", type: "STRING", desc: "YYYY-MM" },
      { name: "city", type: "STRING", desc: "warehouse city" },
      { name: "sku", type: "STRING", desc: "product code" },
      { name: "opening_stock_units", type: "BIGINT", desc: "units on hand at month start" },
      { name: "received_units", type: "BIGINT", desc: "units received during the month" },
      { name: "stockout_days", type: "BIGINT", desc: "days in the month the SKU was out of stock" },
    ],
  },
  {
    name: "ad_platform", system: "Ad platform", desc: "Monthly ad spend, impressions and clicks by city and platform",
    columns: [
      { name: "month", type: "STRING", desc: "YYYY-MM" },
      { name: "city", type: "STRING", desc: "target city" },
      { name: "platform", type: "STRING", desc: "meta | google | radio | billboard" },
      { name: "spend_ngn", type: "DOUBLE", desc: "spend (NGN)" },
      { name: "impressions", type: "BIGINT", desc: "impressions" },
      { name: "clicks", type: "BIGINT", desc: "clicks (0 for offline media)" },
    ],
  },
  {
    name: "price_book", system: "Price book", desc: "List price changes with effective date, SKU, city (or ALL) and reason",
    columns: [
      { name: "effective_date", type: "STRING", desc: "YYYY-MM-DD" },
      { name: "sku", type: "STRING", desc: "product code" },
      { name: "city", type: "STRING", desc: "city, or ALL for every city" },
      { name: "old_price_ngn", type: "DOUBLE", desc: "price before" },
      { name: "new_price_ngn", type: "DOUBLE", desc: "price after" },
      { name: "reason", type: "STRING", desc: "why the price changed" },
    ],
  },
  {
    name: "helpdesk", system: "Helpdesk", desc: "Monthly customer ticket counts by city and category",
    columns: [
      { name: "month", type: "STRING", desc: "YYYY-MM" },
      { name: "city", type: "STRING", desc: "customer city" },
      { name: "category", type: "STRING", desc: "delivery_delay | product_quality | out_of_stock | price_complaint | billing" },
      { name: "tickets", type: "BIGINT", desc: "tickets opened" },
    ],
  },
  {
    name: "logistics", system: "Logistics", desc: "Monthly scheduled vs late deliveries and average delay by city and carrier",
    columns: [
      { name: "month", type: "STRING", desc: "YYYY-MM" },
      { name: "city", type: "STRING", desc: "delivery city" },
      { name: "carrier", type: "STRING", desc: "carrier used that month" },
      { name: "deliveries_scheduled", type: "BIGINT", desc: "deliveries planned" },
      { name: "deliveries_late", type: "BIGINT", desc: "deliveries that arrived late" },
      { name: "avg_delay_hours", type: "DOUBLE", desc: "average delay of late deliveries (hours)" },
    ],
  },
  {
    name: "product_catalog", system: "Product master", desc: "SKU master data",
    columns: [
      { name: "sku", type: "STRING", desc: "product code" },
      { name: "product_name", type: "STRING", desc: "display name" },
      { name: "category", type: "STRING", desc: "snack | mix" },
      { name: "list_price_ngn_2025", type: "DOUBLE", desc: "2025 list price" },
    ],
  },
];

export const DATA_WINDOW = { from: "2025-01", to: "2026-09" };

// Compact schema text for prompts.
export function schemaText(): string {
  return SOURCES.map(
    (t) => `${CONTAINER}.${t.name}  -- ${t.system}: ${t.desc}\n` + t.columns.map((c) => `   ${c.name} ${c.type}  -- ${c.desc}`).join("\n")
  ).join("\n");
}

// Zetaris DDL, one statement per entry (Zetaris runs one statement per call).
export function zetarisDdl(sourceBaseUrl: string): string[] {
  const out: string[] = [
    `CREATE LIGHTNING DATABASE ${LIGHTNING_DB} DESCRIBE BY "Kola Foods internal systems, synthetic demo data served by Causa"`,
    `CREATE SCHEMASTORE CONTAINER ${CONTAINER}`,
  ];
  for (const t of SOURCES) {
    out.push(
      `CREATE LIGHTNING REST TABLE ${t.name}_src FROM ${LIGHTNING_DB} REQUEST(endpoint "${sourceBaseUrl.replace(/\/+$/, "")}/sources/${t.name}.json", method "get", response_type "json", http_encoding "URLENCODED") HEADER () BODY ()`
    );
    const cols = t.columns.map((c) => (c.type === "STRING" ? `r.${c.name} AS ${c.name}` : `CAST(r.${c.name} AS ${c.type}) AS ${c.name}`)).join(", ");
    out.push(`CREATE SCHEMASTORE VIEW ${t.name} WITH CONTAINER ${CONTAINER} AS SELECT ${cols} FROM ${LIGHTNING_DB.toLowerCase()}.${t.name}_src LATERAL VIEW explode(records) AS r`);
  }
  return out;
}
