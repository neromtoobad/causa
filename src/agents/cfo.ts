// CFO agent: quotes every job and enforces its budget. Model calls, Zetaris
// queries, investigation rounds and wall-clock time are all metered. When a
// line is exhausted the CFO refuses further spend and escalates; the run
// then finishes with what it has instead of overspending.

import { config } from "../config.ts";
import type { Contract } from "../domain.ts";
import type { Trace } from "../trace.ts";

export type Line = "modelCalls" | "queries" | "rounds";

export interface Quote {
  maxRounds: number;
  maxQueries: number;
  maxModelCalls: number;
  maxSeconds: number;
  rationale: string;
}

export class CFO {
  quote: Quote;
  readonly spent: Record<Line, number> = { modelCalls: 0, queries: 0, rounds: 0 };
  tokens = 0;
  readonly started = Date.now();
  escalations: string[] = [];

  constructor(private trace: Trace, private caps = config.budget) {
    // Provisional allowance for Intake, before the job is quoted.
    this.quote = { maxRounds: 0, maxQueries: 0, maxModelCalls: 3, maxSeconds: caps.maxSeconds, rationale: "intake allowance" };
  }

  quoteJob(contract: Contract): Quote {
    const caps = this.caps;
    const trace = this.trace;
    // Lookups are cheap; open "why" questions get the full investigation budget.
    const light = contract.intent === "lookup";
    this.quote = {
      maxRounds: light ? 1 : caps.maxRounds,
      maxQueries: light ? 6 : caps.maxQueries,
      maxModelCalls: light ? 8 : caps.maxModelCalls,
      maxSeconds: caps.maxSeconds,
      rationale: light ? "single lookup: one round" : `explain-a-change: up to ${caps.maxRounds} rounds of hypothesis testing`,
    };
    trace.log({
      agent_name: "CFO", action: "quote_job", status: "success",
      input_summary: `intent=${contract.intent} metric=${contract.metric ?? "?"}`,
      output_summary: `budget ${this.quote.maxRounds} rounds, ${this.quote.maxQueries} queries, ${this.quote.maxModelCalls} model calls, ${this.quote.maxSeconds}s (${this.quote.rationale})`,
      data: { quote: this.quote },
    });
    return this.quote;
  }

  private cap(line: Line): number {
    return line === "modelCalls" ? this.quote.maxModelCalls : line === "queries" ? this.quote.maxQueries : this.quote.maxRounds;
  }

  get elapsedSeconds(): number {
    return (Date.now() - this.started) / 1000;
  }

  canSpend(line: Line, n = 1): boolean {
    return this.spent[line] + n <= this.cap(line) && this.elapsedSeconds < this.quote.maxSeconds;
  }

  // Approve and record spend; returns false (and escalates once per line) when over budget.
  approve(line: Line, by: string, n = 1): boolean {
    if (this.canSpend(line, n)) {
      this.spent[line] += n;
      return true;
    }
    const reason = this.elapsedSeconds >= this.quote.maxSeconds ? `time cap ${this.quote.maxSeconds}s` : `${line} cap ${this.cap(line)}`;
    const key = `${line}:${reason}`;
    if (!this.escalations.includes(key)) {
      this.escalations.push(key);
      this.trace.log({
        agent_name: "CFO", action: "deny_spend", target_agent: by, status: "needs_revision",
        input_summary: `${by} asked for ${n} more ${line}`,
        output_summary: `denied: ${reason} reached; finish with the evidence already gathered`,
      });
    }
    return false;
  }

  statement(): Record<string, unknown> {
    return {
      quote: this.quote,
      spent: { ...this.spent, estTokens: this.tokens, seconds: Math.round(this.elapsedSeconds) },
      escalations: this.escalations,
    };
  }
}
