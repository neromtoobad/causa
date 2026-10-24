// CLI entry: run the firm on one input file and print the JSON result.
//   npx tsx src/cli.ts input_examples/example_1.json [--out output_examples/example_1.json]

import { readFileSync, writeFileSync } from "node:fs";
import { runJob, type RunInput } from "./run.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: tsx src/cli.ts <input.json> [--out <output.json>]");
  process.exit(2);
}
const req = JSON.parse(readFileSync(file, "utf8")) as RunInput;
const res = await runJob(req);
const json = JSON.stringify(res, null, 2);
const outIdx = process.argv.indexOf("--out");
if (outIdx > 0) writeFileSync(process.argv[outIdx + 1], json + "\n");
console.log(json);
process.exit(res.status === "error" ? 1 : 0);
