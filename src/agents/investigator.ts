// Investigator: gathers evidence from the client's systems through Zetaris.
// Every query is checked against the signed Scout Intent contract (data.sql
// capability) and approved by the CFO. Playbook kinds use their tested query;
// custom hypotheses and the Skeptic's free-form follow-ups are written by
// Nemotron. A failing query goes back to the model with Zetaris's error for
// repair, up to two times.

import type { Brain } from "../brain.ts";
import { ZetarisClient, ZetarisError, tableText, type QueryResult } from "../adapters/zetaris.ts";
import { schemaText } from "../sources.ts";
import { verify, type ExecutionContract } from "./intake.ts";
import type { CFO } from "./cfo.ts";
import type { Trace } from "../trace.ts";

export class Investigator {
  readonly results = new Map<string, QueryResult>();

  constructor(private zetaris: ZetarisClient, private trace: Trace, private cfo: CFO, private brain: Brain, private contract: () => ExecutionContract) {}

  private guard(): void {
    const v = verify(this.contract(), "data.sql");
    if (!v.ok) {
      this.trace.log({ agent_name: "Investigator", action: "contract_refused", status: "error", input_summary: "data.sql", output_summary: v.reason });
      throw new Error(`contract.refused: ${v.reason}`);
    }
  }

  // Run one SQL statement with budget, contract and repair loop.
  async query(sql: string, purpose: string, opts: { repairable?: boolean; for?: string } = {}): Promise<QueryResult | null> {
    this.guard();
    let current = sql;
    for (let attempt = 0; attempt <= 2; attempt++) {
      if (!this.cfo.approve("queries", "Investigator")) return null;
      try {
        const r = await this.zetaris.run(current);
        this.results.set(r.queryId, r);
        this.trace.log({
          agent_name: "Investigator", action: "run_sql", target_agent: opts.for ? "Skeptic" : undefined, status: "success", retry_count: attempt,
          input_summary: `${purpose}: ${current.slice(0, 220)}`,
          output_summary: `Zetaris (${r.source}) returned ${r.rowCount} rows in ${r.ms}ms as ${r.queryId}`,
          data: { queryId: r.queryId, sql: r.sql, source: r.source, columns: r.columns, rows: r.rows.slice(0, 40) },
        });
        return r;
      } catch (e) {
        const err = e as ZetarisError;
        this.trace.log({
          agent_name: "Investigator", action: "sql_error", status: attempt < 2 && opts.repairable ? "retry" : "error", retry_count: attempt,
          input_summary: `${purpose}: ${current.slice(0, 200)}`, output_summary: `${err.kind ?? "error"}: ${err.message.slice(0, 200)}`,
        });
        if (err.kind === "auth" || !opts.repairable || attempt === 2) return null;
        const fixed = await this.brain.think<{ sql: string }>(
          "Investigator", "fast",
          `You repair SQL for Zetaris (Spark SQL dialect). One SELECT statement only, no semicolon. Avoid self-joins on the same view; use conditional aggregation (SUM(CASE WHEN ...)) instead. Tables:\n${schemaText()}`,
          `Purpose: ${purpose}\nFailed SQL: ${current}\nError: ${err.message}\nReturn {"sql":"..."}`
        );
        if (!fixed?.sql) return null;
        current = fixed.sql;
      }
    }
    return null;
  }

  // Ask Nemotron to write the query for a custom hypothesis or a free-form request.
  async authored(request: string, purpose: string, forAgent?: string): Promise<QueryResult | null> {
    if (!this.brain.online) return null;
    const draft = await this.brain.think<{ sql: string; why: string }>(
      "Investigator", "fast",
      `You are the Investigator at Causa. Write ONE read-only SELECT for Zetaris (Spark SQL) that tests the request. Use only these tables and columns, fully qualified:\n${schemaText()}\nRules: no semicolon; no self-joins on the same view (use SUM(CASE WHEN ...)); GROUP BY anything you select that is not aggregated; at most 50 result rows.`,
      `Request: ${request}\nReturn {"sql":"...","why":"one line"}`
    );
    if (!draft?.sql || !/^\s*select\b/i.test(draft.sql) || /\b(insert|update|delete|drop|create|alter)\b/i.test(draft.sql)) return null;
    return this.query(draft.sql, purpose, { repairable: true, for: forAgent });
  }

  text(id: string): string {
    const r = this.results.get(id);
    return r ? tableText(r) : "";
  }
}
