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
  data?: Record<string, any>;
}
interface Health {
  sample_mode: boolean;
  provider: { status: string; fast: string; deep: string };
  zetaris: { mode: string; ok: boolean };
}
interface Hyp { id: string; kind: string; statement: string; status: string; finding?: string; share?: number; evidence: string[] }
interface Query { queryId: string; sql: string; source: string; columns: string[]; rows: unknown[][] }
type Pose = "idle" | "desk" | "examine" | "approve";

const CAST: { name: string; key: string; role: string; wide?: boolean }[] = [
  { name: "Intake", key: "intake", role: "Scout Intent · contract" },
  { name: "CFO", key: "cfo", role: "Quotes · polices budget" },
  { name: "Planner", key: "planner", role: "Competing hypotheses" },
  { name: "Investigator", key: "investigator", role: "SQL through Zetaris" },
  { name: "Skeptic", key: "skeptic", role: "Attacks every finding" },
  { name: "Writer", key: "writer", role: "The client brief" },
  { name: "Archivist", key: "archivist", role: "H-MEM memory · World Model case file", wide: true },
];

// What each analyst looks like while doing their job.
const WORK_POSE: Record<string, Pose> = { Intake: "examine", CFO: "examine", Planner: "examine", Investigator: "examine", Skeptic: "examine", Writer: "desk", Archivist: "examine" };

const fmt = (x: number, unit: string) => {
  const a = Math.abs(x);
  const s = a >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : `${Math.round(x)}`;
  return unit === "NGN" ? `₦${s}` : `${s} ${unit}`;
};
const month = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
const STAMP: Record<string, string> = { supported: "Confirmed", refuted: "Ruled out", inconclusive: "Unresolved", open: "Testing" };
const DESCRIPTIVE = ["driver_breakdown", "ticket_mix", "channel_shift"];

function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
      <rect width="28" height="28" rx="8" fill="#13271c" />
      <circle cx="13" cy="13" r="6.2" fill="none" stroke="#a3e36a" strokeWidth="2.6" strokeDasharray="30 9" strokeLinecap="round" transform="rotate(35 13 13)" />
      <path d="M17.6 17.6 L22 22" stroke="#a3e36a" strokeWidth="2.8" strokeLinecap="round" />
    </svg>
  );
}

function Arrow() {
  return <span className="pill__ic">→</span>;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [examples, setExamples] = useState<string[]>([]);
  const [question, setQuestion] = useState("Why did Lagos revenue fall in August 2026?");
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [result, setResult] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [drawer, setDrawer] = useState<Query | null>(null);
  const [tab, setTab] = useState<"trace" | "memory">("trace");
  const [memory, setMemory] = useState<any[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const caseRef = useRef<HTMLDivElement | null>(null);

  const loadMemory = () => fetch("/api/memory").then((r) => r.json()).then(setMemory).catch(() => undefined);
  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => undefined);
    fetch("/api/examples").then((r) => r.json()).then(setExamples).catch(() => undefined);
    loadMemory();
  }, []);

  async function hire(q = question) {
    if (!q.trim() || running) return;
    esRef.current?.close();
    setQuestion(q);
    setEvents([]);
    setResult(null);
    setRunning(true);
    setTimeout(() => caseRef.current?.scrollIntoView({ behavior: "smooth" }), 80);
    const { run_id } = await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) }).then((r) => r.json());
    const es = new EventSource(`/api/jobs/${run_id}/events`);
    esRef.current = es;
    es.addEventListener("trace", (m) => setEvents((prev) => [...prev, JSON.parse((m as MessageEvent).data)]));
    es.addEventListener("done", (m) => {
      setResult(JSON.parse((m as MessageEvent).data));
      setRunning(false);
      es.close();
      loadMemory();
    });
    es.onerror = () => {
      es.close();
      setRunning(false);
    };
  }

  const v = useMemo(() => {
    const hyps = new Map<string, Hyp>();
    const queries = new Map<string, Query>();
    const lastBy = new Map<string, TraceEvent>();
    let premise: any = null, quote: any = null, contract: any = null, premiseNote = "", rounds = 0, modelCalls = 0;
    for (const e of events) {
      lastBy.set(e.agent_name, e);
      if (e.model) modelCalls++;
      if (e.action === "quote_job") quote = e.data?.quote;
      if (e.action === "issue_contract") contract = e.data?.contract;
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
    const order = { supported: 0, open: 1, inconclusive: 2, refuted: 3 } as Record<string, number>;
    const sorted = [...hyps.values()].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || Number(DESCRIPTIVE.includes(a.kind)) - Number(DESCRIPTIVE.includes(b.kind)));
    return { hyps: sorted, queries, lastBy, premise, quote, contract, premiseNote, rounds, modelCalls, last: events[events.length - 1] };
  }, [events]);

  const pose = (name: string): Pose => {
    if (running && (v.last?.agent_name === name || v.last?.target_agent === name)) return WORK_POSE[name] ?? "desk";
    if (running && v.lastBy.has(name)) return "desk";
    if (!running && result && v.lastBy.get(name)?.status === "success") return "approve";
    return "idle";
  };

  const brief = result?.output?.brief;
  const live = health?.provider.status === "online";
  const zLive = health?.zetaris.mode === "live" && health.zetaris.ok;
  const opened = running || events.length > 0;

  return (
    <>
      <nav className="nav">
        <div className="nav__bar">
          <a className="logo" href="#top"><Logo /><span className="logo__word">Causa</span></a>
          <div className="nav__links">
            <a href="#case">The case</a>
            <a href="#how">How the firm works</a>
            <a href="#memory">Firm memory</a>
            <a href="https://github.com/neromtoobad/causa" target="_blank" rel="noreferrer">Source</a>
          </div>
          <span className="nav__sp" />
          <span className="status"><i className={live ? "on" : "warn"} />{live ? "Nemotron via Nightshift" : health?.sample_mode ? "Sample mode" : "Model offline"}</span>
          <span className="status"><i className={zLive ? "on" : "warn"} />{zLive ? "Zetaris live" : "Zetaris mirror"}</span>
          <button className="pill dark sm" onClick={() => hire()} disabled={running}>Open a case<Arrow /></button>
        </div>
      </nav>

      <header className="hero" id="top">
        <div className="hero__in">
          <span className="hero__kicker"><i />Client on file · Kòlá Foods, Lagos</span>
          <h1>Ask <em>why</em>.<br />Get an answer<br />you can check.</h1>
          <p className="hero__lede">Seven analysts take your question, test competing explanations against your own systems through Zetaris, argue over the evidence, and hand back a brief where every claim is tied to the query and rows behind it.</p>
          <div className="ask">
            <textarea value={question} rows={1} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); hire(); } }} placeholder="Why did … ?" aria-label="Your question" />
            <button className="pill dark lg" onClick={() => hire()} disabled={running || !question.trim()}>{running ? "Investigating" : "Open the case"}<Arrow /></button>
          </div>
          <div className="chips">
            {examples.map((x) => <button key={x} className="chip" onClick={() => hire(x)} disabled={running}>{x.replace(/\?$/, "")}</button>)}
          </div>
        </div>
        <div className="hero__foot"><span>Zetaris · Meterless · Nemotron</span><span>Every claim cited · what it wasn't, too</span></div>
      </header>

      <main className="wrap">
        <section className="section" id="case" ref={caseRef}>
          <div className="section__head">
            <span className="label"><span className="n">01</span>The case</span>
            <h2>{opened ? (v.premise ? `${v.premise.metric[0].toUpperCase()}${v.premise.metric.slice(1)}, ${Object.values(v.premise.filters).filter(Boolean).join(" · ") || "all cities"}` : "Reading the question…") : "Open a case to watch the firm work."}</h2>
            <p>{opened ? question : "The analysts measure the change, propose explanations, test each one against the client's ERP, warehouse, ad platform, price book, helpdesk and logistics systems, and stamp every hypothesis confirmed or ruled out."}</p>
          </div>

          <div className="case">
            {/* the cast */}
            <div className="panel">
              <div className="panel__h"><span>The case room</span><span>{running ? "working" : result ? "closed" : "ready"}</span></div>
              <div className="panel__b room">
                {CAST.map((a) => {
                  const e = v.lastBy.get(a.name);
                  const on = running && v.last?.agent_name === a.name;
                  const next = running && !on && v.last?.target_agent === a.name;
                  return (
                    <div key={a.name} className={`desk ${a.wide ? "wide" : ""} ${on ? "on" : next ? "next" : ""}`}>
                      {on && <span className="dots"><i /><i /><i /></span>}
                      <div className="sprite"><img src={`/cast/${a.key}-${pose(a.name)}.webp`} alt={`${a.name}, ${pose(a.name)}`} /></div>
                      <div>
                        <b>{a.name}</b>
                        <small>{a.role}</small>
                        <div className="said">{e ? e.output_summary : "At the desk."}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* the board */}
            <div>
              {brief && (
                <div className="brief on-deep">
                  <span className="label"><span className="n">✓</span>The brief · {result.run_id}</span>
                  <h2>{brief.headline}</h2>
                  <p className="brief__sum">{brief.summary}</p>
                  {brief.premise_note && <p className="brief__sum" style={{ marginTop: 10 }}><b>Premise check:</b> {brief.premise_note}</p>}
                  {result.output.recommendations?.length > 0 && (
                    <div className="recs">{result.output.recommendations.map((r: string) => <div className="rec" key={r}><i>→</i><span>{r}</span></div>)}</div>
                  )}
                  {brief.caveats?.map((c: string) => <p className="brief__cav" key={c}>{c}</p>)}
                  <div className="brief__meta">
                    <span>{brief.causes.length} causes · {brief.ruled_out.length} ruled out</span>
                    <span>{v.queries.size} queries · {result.execution_time_seconds}s</span>
                    <span>written by {brief.written_by === "model" ? "Nemotron Ultra" : "the firm's rules"}</span>
                    <a className="pill leaf sm" href={`data:application/json,${encodeURIComponent(JSON.stringify(result, null, 2))}`} download={`${result.run_id}.json`}>Brief JSON<Arrow /></a>
                  </div>
                </div>
              )}
              {result?.status === "declined" && (
                <div className="brief on-deep"><span className="label"><span className="n">!</span>Declined at intake</span><h2>{result.output.summary}</h2></div>
              )}

              <div className="panel">
                <div className="panel__h"><span>The board · World Model case file</span><span>{v.hyps.filter((h) => h.status !== "open").length}/{v.hyps.length} stamped</span></div>
                <div className="panel__b">
                  {v.premise ? (
                    <div className="change">
                      <span className={`change__n ${v.premise.premise.change < 0 ? "down" : "up"}`}>
                        {v.premise.premise.changePct === null ? "n/a" : `${v.premise.premise.changePct > 0 ? "+" : ""}${(v.premise.premise.changePct * 100).toFixed(1)}%`}
                      </span>
                      <div className="change__what">
                        <b>{fmt(v.premise.premise.baseline, v.premise.unit)} → {fmt(v.premise.premise.target, v.premise.unit)}</b>
                        <span>{month(v.premise.baseline_month)} → {month(v.premise.target_month)}</span>
                      </div>
                      <span style={{ flex: 1 }} />
                      <button className="tag" onClick={() => setDrawer(v.queries.get(v.premise.queryId) ?? null)}>{v.premise.queryId}</button>
                    </div>
                  ) : (
                    <p className="empty">{running ? "Intake is reading the question and signing the contract…" : "No case open yet."}</p>
                  )}
                  {v.premiseNote && <div className="note">{v.premiseNote}</div>}
                  <div className="cards">
                    {v.hyps.map((h) => (
                      <article className={`card ${h.status}`} key={h.id}>
                        <div className="card__top">
                          <div>
                            <div className="card__id">{h.id} · {h.kind.replace(/_/g, " ")}</div>
                            <h4>{h.statement}</h4>
                          </div>
                          <span className={`stamp ${h.status}`}>{STAMP[h.status] ?? h.status}</span>
                        </div>
                        {h.finding && <p>{h.finding}</p>}
                        {h.status === "supported" && typeof h.share === "number" && !DESCRIPTIVE.includes(h.kind) && (
                          <div className="share"><span>explains ~{Math.round(h.share * 100)}%</span><span className="share__bar"><i style={{ width: `${Math.round(h.share * 100)}%` }} /></span></div>
                        )}
                        {h.evidence.length > 0 && (
                          <div className="tags">{h.evidence.map((q) => <button key={q} className="tag" onClick={() => setDrawer(v.queries.get(q) ?? null)}>{q} · {v.queries.get(q)?.source ?? "zetaris"}</button>)}</div>
                        )}
                      </article>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* the ledger */}
            <div style={{ display: "grid", gap: 16 }}>
              <div className="receipt">
                <div className="receipt__h">Causa<span>{result?.run_id ?? (running ? "in progress" : "no case")}</span></div>
                {[
                  ["Rounds", v.rounds, v.quote?.maxRounds],
                  ["Zetaris queries", v.queries.size, v.quote?.maxQueries],
                  ["Nemotron calls", result?.cost?.spent?.modelCalls ?? v.modelCalls, v.quote?.maxModelCalls],
                ].map(([l, used, cap]) => (
                  <div className="ln" key={String(l)}>
                    <span>{l}</span><span>{used as number} / {cap ?? "–"}</span>
                    <span className="bar"><i style={{ width: cap ? `${Math.min(100, ((used as number) / (cap as number)) * 100)}%` : "0%" }} /></span>
                  </div>
                ))}
                <div className="eng"><b>Scout Intent</b><span>{v.contract ? `${v.contract.intent.primary.split(".")[1]} · risk ${v.contract.risk.level}` : "–"}</span></div>
                <div className="eng"><b>H-MEM</b><span>{result?.engines?.hmem ?? "–"}</span></div>
                <div className="eng"><b>World Model</b><span>{result?.engines?.world_model ?? (v.hyps.length ? "case file open" : "–")}</span></div>
                <div className="eng"><b>Markovian</b><span>{result?.engines?.markovian?.split(",")[0] ?? (v.rounds ? `step ${v.rounds}` : "–")}</span></div>
              </div>

              <div className="panel">
                <div className="tabs">
                  <button className={tab === "trace" ? "on" : ""} onClick={() => setTab("trace")}>Trace</button>
                  <button className={tab === "memory" ? "on" : ""} onClick={() => setTab("memory")}>Memory</button>
                </div>
                <div className="panel__b">
                  {tab === "trace" ? (
                    <div className="log">
                      {events.length === 0 && <p className="empty">Every agent action lands here as it happens, and in logs/trace-&lt;run&gt;.jsonl.</p>}
                      {[...events].reverse().map((e, i) => (
                        <div key={i} className={`s-${e.status}`}>
                          <span className="a">{e.agent_name}</span>{e.target_agent ? ` → ${e.target_agent}` : ""} · {e.action.replace(/_/g, " ")}{e.model ? ` · ${e.model.replace("nvidia/", "")}` : ""}
                          <br />{e.output_summary.slice(0, 200)}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <MemoryList memory={memory} />
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="how">
          <div className="section__head">
            <span className="label"><span className="n">02</span>How the firm works</span>
            <h2>Four steps. Nothing taken on faith.</h2>
          </div>
          <div className="steps">
            {[
              { n: "01", a: ["intake-examine", "cfo-examine"], h: "Signed, then quoted", p: "Intake turns your question into a signed contract and refuses anything that tries to change data or the agents' instructions. The CFO quotes the job and stops spend at the cap.", e: "Scout Intent" },
              { n: "02", a: ["planner-examine", "investigator-examine"], h: "Competing explanations, tested", p: "The Planner proposes rival causes, starting from what the firm already knows. The Investigator tests each with SQL across the client's systems through Zetaris.", e: "Zetaris · Markovian" },
              { n: "03", a: ["skeptic-examine"], h: "The Skeptic pushes back", p: "Every finding is judged from the rows. When the model and the numbers disagree, the Skeptic makes it reconsider, and asks for follow-up evidence before anything is confirmed.", e: "World Model · Nemotron" },
              { n: "04", a: ["writer-desk", "archivist-examine"], h: "A brief you can check", p: "The Writer explains what happened, what it wasn't, and what is still unknown. Every claim links to its query. The Archivist files the findings so the next case starts smarter.", e: "H-MEM" },
            ].map((s) => (
              <div className="step" key={s.n}>
                <div className="step__art">{s.a.map((x) => <img key={x} src={`/cast/${x}.webp`} alt="" />)}</div>
                <div className="step__b"><span className="step__n">{s.n} / 04</span><h3>{s.h}</h3><p>{s.p}</p><span className="eng-tag">{s.e}</span></div>
              </div>
            ))}
          </div>
        </section>

        <section className="section" id="memory">
          <div className="section__head">
            <span className="label"><span className="n">03</span>What the firm remembers</span>
            <h2>Every verdict is filed, with its evidence.</h2>
            <p>Findings go into H-MEM with provenance: the Zetaris queries that proved them. The next question about the same business starts from here and skips what was already ruled out.</p>
          </div>
          <div className="panel"><div className="panel__b"><MemoryList memory={memory.slice(0, 12)} /></div></div>
        </section>
      </main>

      <div className="stack">
        {[
          { s: "Data", h: "Zetaris", p: "One SQL access point over the client's six systems, each registered as a REST table. Every piece of evidence is a Zetaris query." },
          { s: "Engines", h: "Meterless", p: "Scout Intent signs every job, H-MEM remembers, the World Model holds the shared case file, Markovian keeps rounds bounded. Nightshift serves the models." },
          { s: "Reasoning", h: "NVIDIA Nemotron", p: "Nemotron 3 Ultra plans, judges and writes. Nemotron 3.5 Lightning binds parameters and writes the SQL. Both run through Nightshift." },
        ].map((x) => <div className="stack__i" key={x.h}><small>{x.s}</small><h3>{x.h}</h3><p>{x.p}</p></div>)}
      </div>

      <footer className="foot">
        <div>
          <a className="logo" href="#top" style={{ color: "#fff" }}><Logo /><span className="logo__word">Causa</span></a>
          <p>The analyst firm that tells you why. Built for the Open Agent Hackathon 2026, track 2: The Agent That Can Explain Why. Kòlá Foods is fictional; its data is synthetic.</p>
        </div>
        <div>
          <h5>For judges</h5>
          <a href="https://github.com/neromtoobad/causa" target="_blank" rel="noreferrer">Source on GitHub ↗</a>
          <a href="/api/health" target="_blank" rel="noreferrer">Health ↗</a>
          <a href="#case">POST /run</a>
        </div>
        <div>
          <h5>The firm</h5>
          <a href="#case">The case room</a>
          <a href="#how">How it works</a>
          <a href="#memory">Firm memory</a>
        </div>
        <div className="foot__base"><span>© 2026 Causa</span><span>Every claim cited</span></div>
      </footer>

      {drawer && (
        <div className="drawer-bg" onClick={() => setDrawer(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <button className="pill line sm x" onClick={() => setDrawer(null)}>Close<Arrow /></button>
            <span className="label"><span className="n">EV</span>Evidence</span>
            <h4>{drawer.queryId}</h4>
            <p className="muted" style={{ marginBottom: 12, fontSize: 14 }}>Ran on {drawer.source === "live" ? "Zetaris (live)" : drawer.source === "cache" ? "Zetaris (recorded result)" : "the local mirror of the same tables (sample mode)"}</p>
            <pre>{drawer.sql}</pre>
            <table className="rows">
              <thead><tr>{drawer.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{drawer.rows.map((r, i) => <tr key={i}>{r.map((x, j) => <td key={j}>{typeof x === "number" ? (Number.isInteger(x) ? x.toLocaleString() : x.toFixed(2)) : String(x)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function MemoryList({ memory }: { memory: any[] }) {
  if (!memory.length) return <p className="empty">Nothing filed yet. Findings from finished cases land here with their evidence.</p>;
  return (
    <>
      {memory.map((m) => {
        const head = m.content.split(":")[0];
        return (
          <div className="mem" key={m.id}>
            <b className={head.startsWith("RULED") ? "out" : ""}>{head}</b>{m.content.slice(m.content.indexOf(":") + 1, 260)}
            <small>{m.layer.replace("_", " ")} · confidence {Number(m.confidence).toFixed(2)} · evidence {m.refs.join(", ")}</small>
          </div>
        );
      })}
    </>
  );
}
