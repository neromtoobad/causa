// Dev helper: run a few questions and print the brief in short form.
//   SAMPLE_MODE=true npx tsx scripts/probe.ts "question" ["question" ...]
import { runJob } from "../src/run.ts";

for (const q of process.argv.slice(2)) {
  const r = await runJob({ input: { query: q } }, { quiet: true });
  console.log(`\n== ${q}\nstatus: ${r.status}`);
  const b = r.output.brief;
  if (!b) {
    console.log(r.output.summary);
    continue;
  }
  console.log(b.headline);
  console.log("causes:", b.causes.map((x) => `${x.id} ${x.statement}${x.share !== undefined ? ` ${Math.round(x.share * 100)}%` : ""}`));
  console.log("ruled out:", b.ruled_out.map((x) => x.statement));
  console.log("unresolved:", b.unresolved.map((x) => x.statement), "explained", b.explained_share);
  console.log(r.engines, r.cost.spent);
}
