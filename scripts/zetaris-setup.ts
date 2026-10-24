// Registers the client's systems in Zetaris: one Lightning database, one
// SchemaStore container, a REST table per system (served by Causa at
// /sources/<name>.json) and a flattening view per table. Runs one statement
// at a time, as Zetaris requires, and treats "already exists" as done.
// Needs Causa running (npm start) so Zetaris can fetch the JSON, and
// ZETARIS_API_KEY in the environment.
//
//   SOURCE_BASE_URL=http://host.docker.internal:8000 npx tsx --env-file=.env scripts/zetaris-setup.ts
//   add --dry-run to print the statements only

import { ZetarisClient, ZetarisError } from "../src/adapters/zetaris.ts";
import { CONTAINER, SOURCES, zetarisDdl } from "../src/sources.ts";

const base = process.env.SOURCE_BASE_URL ?? "http://host.docker.internal:8000";
const statements = zetarisDdl(base);

if (process.argv.includes("--dry-run")) {
  for (const s of statements) console.log(s + ";\n");
  process.exit(0);
}

const z = new ZetarisClient(undefined, false);
if (z.mode !== "live") {
  console.error("ZETARIS_API_KEY is not set (or SAMPLE_MODE=true); nothing to register.");
  process.exit(1);
}

for (const sql of statements) {
  const label = sql.slice(0, 90);
  try {
    await z.run(sql);
    console.log(`PASS  ${label}`);
  } catch (e) {
    const msg = (e as Error).message;
    if (/already exist/i.test(msg)) console.log(`SKIP  ${label}  (already exists)`);
    else {
      console.log(`FAIL  ${label}\n      ${msg}`);
      if ((e as ZetarisError).kind === "auth") process.exit(1);
    }
  }
}

// Verify: every view answers, with a row count.
for (const t of SOURCES) {
  try {
    const r = await z.run(`SELECT COUNT(*) AS n FROM ${CONTAINER}.${t.name}`);
    console.log(`ROWS  ${CONTAINER}.${t.name}: ${r.rows[0]?.[0]}`);
  } catch (e) {
    console.log(`FAIL  ${CONTAINER}.${t.name}: ${(e as Error).message}`);
  }
}
