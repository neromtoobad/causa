import { useEffect, useMemo, useRef, useState } from "react";

type Status = "success" | "needs_revision" | "retry" | "error" | "fallback" | "info";
interface TraceEvent {
  timestamp: string;
  agent_name: string;
  action: string;
  input_summary: string;
  output_summary: string;
  target_agent?: string;
  status: Status;
  model?: string;
  confidence?: number;
  data?: Record<string, any>;
}
interface Health {
  sample_mode: boolean;
  provider: { status: string; models: string[]; fast: string; deep: string; base_url: string };
  zetaris: { mode: string; ok: boolean; detail: string };
}
interface Hyp {
  id: string;
  kind: string;
  statement: string;
  status: string;
  finding?: string;
  share?: number;
  evidence: string[];
}
interface Query {
  queryId: string;
  sql: string;
  source: string;
  columns: string[];
  rows: unknown[][];
}

const AGENTS: { name: string; role: string; color: string; wide?: boolean }[] = [
  { name: "Intake", role: "Scout Intent · signed contract", color: "#2a6b59" },
  { name: "CFO", role: "Quotes and polices the budget", color: "#b0893d" },
  { name: "Planner", role: "Competing hypotheses", color: "#17473b" },
  { name: "Investigator", role: "SQL through Zetaris", color: "#35596f" },
  { name: "Skeptic", role: "Attacks every finding", color: "#a8432f" },
  { name: "Writer", role: "The client brief", color: "#6b5a8a" },
  { name: "Archivist", role: "H-MEM memory · World Model case file", color: "#4a463d", wide: true },
];

const fmt = (x: number, unit: string) => {
  const a = Math.abs(x);
  const s = a >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : `${Math.round(x)}`;
  return unit === "NGN" ? `₦${s}` : `${s} ${unit}`;
};
const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [examples, setExamples] = useState<string[]>([]);
  const [question, setQuestion] = useState("Why did Lagos revenue fall in August 2026?");
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [result, setResult] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [drawer, setDrawer] = useState<Query | null>(null);
  const [tab, setTab] = useState<"log" | "memory">("log");
  const [memory, setMemory] = useState<any[]>([]);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => undefined);
    fetch("/api/examples").then((r) => r.json()).then(setExamples).catch(() => undefined);
    fetch("/api/memory").then((r) => r.json()).then(setMemory).catch(() => undefined);
  }, []);

  async function hire() {
    if (!question.trim() || running) return;
    esRef.current?.close();
    setEvents([]);
    setResult(null);
    setRunning(true);
    const { run_id } = await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: question }) }).then((r) => r.json());
    const es = new EventSource(`/api/jobs/${run_id}/events`);
    esRef.current = es;
    es.addEventListener("trace", (m) => setEvents((prev) => [...prev, JSON.parse((m as MessageEvent).data)]));
    es.addEventListener("done", (m) => {
      setResult(JSON.parse((m as MessageEvent).data));
      setRunning(false);
      es.close();
      fetch("/api/memory").then((r) => r.json()).then(setMemory).catch(() => undefined);
    });
    es.onerror = () => {
      es.close();
      setRunning(false);
    };
  }

  // ----- derived state from the live trace -----
  const view = useMemo(() => {
    const hyps = new Map<string, Hyp>();
    const queries = new Map<string, Query>();
    const lastBy = new Map<string, TraceEvent>();
    let premise: any = null;
    let quote: any = null;
    let contract: any = null;
    let recalled: any[] | null = null;
    let rounds = 0;
    let modelCalls = 0;
    let premiseNote = "";
    for (const e of events) {
      lastBy.set(e.agent_name, e);
      if (e.model) modelCalls++;
      if (e.action === "quote_job") quote = e.data?.quote;
      if (e.action === "issue_contract") contract = e.data?.contract;
      if (e.action === "recall_memory") recalled = e.data?.memories ?? [];
      if (e.action === "round_start") rounds++;
      if (e.action === "measure_change") premise = e.data;
      if (e.action === "challenge_premise") premiseNote = e.output_summary;
      if (e.action === "run_sql" && e.data) queries.set(e.data.queryId, e.data as Query);
      if ((e.action === "plan_hypotheses" || e.action === "replan_hypotheses") && e.data?.hypotheses)
        for (const h of e.data.hypotheses) hyps.set(h.id, { id: h.id, kind: h.kind, statement: h.statement, status: "open", evidence: [] });
      if ((e.action === "judge" || e.action === "accept_follow_up") && e.data?.hypothesis) {
        const prev = hyps.get(e.data.hypothesis);
        hyps.set(e.data.hypothesis, { ...(prev ?? { id: e.data.hypothesis, kind: e.data.kind, evidence: [] }), statement: e.data.statement, status: e.data.verdict, finding: e.data.finding, share: e.data.impactShare, evidence: e.data.evidence ?? prev?.evidence ?? [] } as Hyp);
      }
    }
    const last = events[events.length - 1];
    return { hyps: [...hyps.values()], queries, lastBy, premise, quote, contract, recalled, rounds, modelCalls, premiseNote, last };
  }, [events]);

  const queriesRun = view.queries.size;
  const brief = result?.output?.brief;
  const providerOn = health?.provider.status === "online";

  return (
    <>
      <header className="top">
        <div className="brand">
          <b>Causa</b>
          <span>the analyst firm that tells you why</span>
        </div>
        <div className="chips">
          <span className="chip"><i className={`dot ${providerOn ? "on" : "warn"}`} /> Meterless Nightshift {providerOn ? "online" : health?.sample_mode ? "· sample mode" : "offline"}</span>
          <span className="chip"><i className={`dot ${health?.zetaris.mode === "live" && health.zetaris.ok ? "on" : "warn"}`} /> Zetaris {health?.zetaris.mode === "live" ? (health.zetaris.ok ? "live" : "unreachable") : "mirror"}</span>
          <span className="chip">H-MEM · World Model · Markovian · Scout Intent</span>
        </div>
      </header>

      <main className="wrap">
        <section className="hero">
          <div>
            <h1>
              Ask <em>why</em>.<br />Get an answer you can check.
            </h1>
            <p>Seven AI analysts take your question, test competing explanations against your own systems through Zetaris, argue over the evidence, and hand back a brief where every claim links to the query and rows behind it.</p>
            <div className="client">
              Client on file: <b>Kòlá Foods</b>, a Lagos snack distributor · ERP, warehouse, ad platform, price book, helpdesk and logistics systems · synthetic demo data
            </div>
          </div>
          <div className="ask">
            <textarea value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && hire()} placeholder="Why did … ?" />
            <div className="ask-row">
              <div className="examples">
                {examples.map((x) => (
                  <button key={x} onClick={() => setQuestion(x)}>{x.replace(/\?$/, "")}</button>
                ))}
              </div>
              <button className="go" onClick={hire} disabled={running || !question.trim()}>{running ? "Investigating…" : "Hire the firm"}</button>
            </div>
          </div>
        </section>

        <section className="grid">
          {/* office */}
          <div className="panel">
            <h3>The office <span>{running ? "live" : events.length ? "done" : "idle"}</span></h3>
            <div className="body office">
              {AGENTS.map((a) => {
                const e = view.lastBy.get(a.name);
                const active = running && view.last?.agent_name === a.name;
                const handoff = running && view.last?.target_agent === a.name;
                return (
                  <div key={a.name} className={`desk ${a.wide ? "wide" : ""} ${active ? "active" : handoff ? "handoff" : ""}`}>
                    {active && <span className="typing"><i /><i /><i /></span>}
                    <div className="who">
                      <span className="avatar" style={{ background: a.color }}>{a.name[0]}</span>
                      <div>
                        <b>{a.name}</b>
                        <small>{a.role}</small>
                      </div>
                    </div>
                    <div className="said">{e ? `${e.action.replace(/_/g, " ")} · ${e.output_summary}` : <span style={{ color: "var(--ink-3)" }}>waiting</span>}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* case file + brief */}
          <div>
            {brief && (
              <div className="brief">
                <div className="label">The brief · {result.run_id}</div>
                <h2>{brief.headline}</h2>
                <p>{brief.summary}</p>
                {brief.premise_note && <p><b>Premise check:</b> {brief.premise_note}</p>}
                {result.output.recommendations?.length > 0 && (
                  <div className="recs">
                    {result.output.recommendations.map((r: string) => (
                      <div className="rec" key={r}>→ {r}</div>
                    ))}
                  </div>
                )}
                {brief.caveats?.map((c: string) => (
                  <div className="caveat" key={c}>{c}</div>
                ))}
                <div className="meta">
                  <span>{brief.causes.length} causes · {brief.ruled_out.length} ruled out</span>
                  <span>{queriesRun} queries · {result.execution_time_seconds}s</span>
                  <span>written by {brief.written_by === "model" ? "Nemotron via Nightshift" : "the firm's rules"}</span>
                  <a style={{ color: "#fff" }} href={`data:application/json,${encodeURIComponent(JSON.stringify(result, null, 2))}`} download={`${result.run_id}.json`}>download JSON</a>
                </div>
              </div>
            )}

            <div className="panel">
              <h3>Case file <span>World Model</span></h3>
              <div className="body">
                {view.premise ? (
                  <div className="change">
                    <span className={`big ${view.premise.premise.change < 0 ? "down" : "up"}`}>
                      {view.premise.premise.changePct === null ? "n/a" : `${view.premise.premise.changePct > 0 ? "+" : ""}${(view.premise.premise.changePct * 100).toFixed(1)}%`}
                    </span>
                    <span>
                      <b>{view.premise.metric}</b> {fmt(view.premise.premise.baseline, view.premise.unit)} → {fmt(view.premise.premise.target, view.premise.unit)}
                    </span>
                    <span className="ctx">
                      {Object.values(view.premise.filters).filter(Boolean).join(" · ") || "all cities"} · {monthLabel(view.premise.baseline_month)} → {monthLabel(view.premise.target_month)} ·{" "}
                      <button className="close" style={{ float: "none", padding: "2px 8px", fontSize: 11 }} onClick={() => setDrawer(view.queries.get(view.premise.queryId) ?? null)}>{view.premise.queryId}</button>
                    </span>
                  </div>
                ) : (
                  <div className="empty">{running ? "Intake is reading the question…" : events.length ? result?.output?.summary : "Ask a question to open a case. The firm will measure the change, then test explanations against the client's systems."}</div>
                )}
                {view.premiseNote && <div className="premise">{view.premiseNote}</div>}
                {view.hyps.map((h) => (
                  <div className="hyp" key={h.id}>
                    <div className="hyp-top">
                      <div>
                        <span className="id">{h.id}</span>
                        <span className="t">{h.statement}</span>
                        <div className="kind">{h.kind.replace(/_/g, " ")}</div>
                      </div>
                      <span className={`pill ${h.status}`}>{h.status === "supported" ? "confirmed" : h.status === "refuted" ? "ruled out" : h.status === "open" ? "testing" : h.status}</span>
                    </div>
                    {h.finding && <div className="finding">{h.finding}</div>}
                    {h.status === "supported" && typeof h.share === "number" && !["driver_breakdown", "ticket_mix", "channel_shift"].includes(h.kind) && (
                      <div className="share" title={`explains ~${Math.round(h.share * 100)}% of the change`}><i style={{ width: `${Math.round(h.share * 100)}%` }} /></div>
                    )}
                    {h.evidence.length > 0 && (
                      <div className="ev">
                        {h.evidence.map((q) => (
                          <button key={q} onClick={() => setDrawer(view.queries.get(q) ?? null)}>{q} · {view.queries.get(q)?.source ?? ""}</button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ledger */}
          <div>
            <div className="panel" style={{ marginBottom: 16 }}>
              <h3>CFO ledger <span>budget</span></h3>
              <div className="body">
                {[
                  ["Rounds", view.rounds, view.quote?.maxRounds],
                  ["Zetaris queries", queriesRun, view.quote?.maxQueries],
                  ["Model calls", result?.cost?.spent?.modelCalls ?? view.modelCalls, view.quote?.maxModelCalls],
                ].map(([label, used, cap]) => (
                  <div className="meter" key={String(label)}>
                    <div className="row"><span>{label}</span><span>{used as number} / {cap ?? "–"}</span></div>
                    <div className="bar"><i style={{ width: cap ? `${Math.min(100, ((used as number) / (cap as number)) * 100)}%` : "0%" }} /></div>
                  </div>
                ))}
                <div className="engine"><b>Scout Intent</b><span>{view.contract ? `${view.contract.intent.primary} · risk ${view.contract.risk.level} · ${view.contract.contractId.slice(0, 8)}` : "–"}</span></div>
                <div className="engine"><b>H-MEM</b><span>{result?.engines?.hmem ?? (view.recalled ? `${view.recalled.length} recalled` : "–")}</span></div>
                <div className="engine"><b>World Model</b><span>{result?.engines?.world_model ?? (view.hyps.length ? "case file open" : "–")}</span></div>
                <div className="engine"><b>Markovian</b><span>{result?.engines?.markovian ?? (view.rounds ? `step ${view.rounds}` : "–")}</span></div>
              </div>
            </div>
            <div className="panel">
              <div className="tabs">
                <button className={tab === "log" ? "on" : ""} onClick={() => setTab("log")}>Trace</button>
                <button className={tab === "memory" ? "on" : ""} onClick={() => setTab("memory")}>Firm memory</button>
              </div>
              <div className="body">
                {tab === "log" ? (
                  <div className="log">
                    {events.length === 0 && <div className="empty">Every agent action lands here as it happens (also in logs/trace-&lt;run&gt;.jsonl).</div>}
                    {[...events].reverse().map((e, i) => (
                      <div key={i} className={`s-${e.status}`}>
                        <span className="a">{e.agent_name}</span>{e.target_agent ? ` → ${e.target_agent}` : ""} · {e.action.replace(/_/g, " ")}
                        {e.model ? <em> [{e.model}]</em> : null}
                        <br />
                        {e.output_summary.slice(0, 180)}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div>
                    {memory.length === 0 && <div className="empty">Nothing yet. Findings from finished cases are stored here with provenance and recalled by the Planner next time.</div>}
                    {memory.map((m) => (
                      <div className="memory" key={m.id}>
                        <b>{m.content.split(":")[0]}</b>
                        {m.content.slice(m.content.indexOf(":"))}
                        <div className="kind">{m.layer} · confidence {m.confidence?.toFixed?.(2)} · evidence {m.refs.join(", ")}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        <div className="foot">Causa · built for the Open Agent Hackathon 2026 · Zetaris (data) · Meterless engines + Nightshift (power) · NVIDIA Nemotron · Kòlá Foods is fictional</div>
      </main>

      {drawer && (
        <div className="drawer-bg" onClick={() => setDrawer(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <button className="close" onClick={() => setDrawer(null)}>Close</button>
            <h4>Evidence {drawer.queryId}</h4>
            <div className="kind" style={{ marginBottom: 10 }}>Ran on {drawer.source === "live" ? "Zetaris (live)" : drawer.source === "cache" ? "Zetaris (recorded result)" : "the local mirror of the same tables (sample mode)"}</div>
            <pre>{drawer.sql}</pre>
            <table className="rows">
              <thead>
                <tr>{drawer.columns.map((c) => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {drawer.rows.map((r, i) => (
                  <tr key={i}>{r.map((v, j) => <td key={j}>{typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)) : String(v)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
