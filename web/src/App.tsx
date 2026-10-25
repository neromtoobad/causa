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

const STAFF: { name: string; key: string; role: string; wide?: boolean }[] = [
  { name: "Intake", key: "intake", role: "Scout Intent · signs the contract" },
  { name: "CFO", key: "cfo", role: "Quotes the job · polices spend" },
  { name: "Planner", key: "planner", role: "Rival explanations" },
  { name: "Investigator", key: "investigator", role: "SQL through Zetaris" },
  { name: "Skeptic", key: "skeptic", role: "Attacks every finding" },
  { name: "Writer", key: "writer", role: "Types the memorandum" },
  { name: "Archivist", key: "archivist", role: "H-MEM memory · World Model case file", wide: true },
];
const WORK_POSE: Record<string, Pose> = { Intake: "examine", CFO: "examine", Planner: "examine", Investigator: "examine", Skeptic: "examine", Writer: "desk", Archivist: "examine" };
const STAMP: Record<string, string> = { supported: "Confirmed", refuted: "Ruled out", inconclusive: "Unresolved", open: "Under test" };
const DESCRIPTIVE = ["driver_breakdown", "ticket_mix", "channel_shift"];

const fmt = (x: number, unit: string) => {
  const a = Math.abs(x);
  const s = a >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : `${Math.round(x)}`;
  return unit === "NGN" ? `₦${s}` : `${s} ${unit}`;
};
const month = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
const caseNo = (id?: string) => (id ? id.replace(/^run-/, "").slice(-6).toUpperCase() : "—");
const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [examples, setExamples] = useState<string[]>([]);
  const [question, setQuestion] = useState("Why did Lagos revenue fall in August 2026?");
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [result, setResult] = useState<any>(null);
  const [runId, setRunId] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [drawer, setDrawer] = useState<Query | null>(null);
  const [tab, setTab] = useState<"log" | "memory">("log");
  const [memory, setMemory] = useState<any[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const caseRef = useRef<HTMLDivElement | null>(null);

  const loadMemory = () => fetch("/api/memory").then((r) => r.json()).then(setMemory).catch(() => undefined);
  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => undefined);
    fetch("/api/examples").then((r) => r.json()).then(setExamples).catch(() => undefined);
    loadMemory();
  }, []);

  async function open(q = question) {
    if (!q.trim() || running) return;
    esRef.current?.close();
    setQuestion(q);
    setEvents([]);
    setResult(null);
    setRunning(true);
    setTimeout(() => caseRef.current?.scrollIntoView({ behavior: "smooth" }), 80);
    const { run_id } = await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) }).then((r) => r.json());
    setRunId(run_id);
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
  const confirmed = v.hyps.filter((h) => h.status === "supported" && !DESCRIPTIVE.includes(h.kind)).length;

  return (
    <>
      <nav className="nav">
        <div className="nav__bar">
          <a className="logo" href="#top"><span className="logo__word">Causa</span><span className="conf">Confidential</span></a>
          <div className="nav__links">
            <a href="#case">The case</a>
            <a href="#method">Method</a>
            <a href="#archive">Archive</a>
            <a href="https://github.com/neromtoobad/causa" target="_blank" rel="noreferrer">Source</a>
          </div>
          <span className="nav__sp" />
          <span className="status"><i className={live ? "on" : "warn"} />{live ? "Nemotron · Nightshift" : health?.sample_mode ? "Sample mode" : "Model offline"}</span>
          <span className="status"><i className={zLive ? "on" : "warn"} />{zLive ? "Zetaris live" : "Zetaris mirror"}</span>
          <button className="btn sm" onClick={() => open()} disabled={running}>Open a case ▸</button>
        </div>
      </nav>

      <header className="wrap hero" id="top">
        <div className="folder" data-tab={`CASE ${caseNo(runId) === "—" ? "0147" : caseNo(runId)} · KÒLÁ FOODS`}>
          <div className="hero__grid">
            <div>
              <h1>Ask <u>why</u>.<br />Get it on file.</h1>
              <p className="hero__lede">Seven analysts open a case on your question, test every explanation against your own systems through Zetaris, argue over the evidence, and close it with a memorandum where each claim cites the query and rows that prove it.</p>
              <div className="ask">
                <textarea value={question} rows={1} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); open(); } }} placeholder="Why did … ?" aria-label="Your question" />
                <button className="btn lg" onClick={() => open()} disabled={running || !question.trim()}>{running ? "Investigating…" : "Open case ▸"}</button>
              </div>
              <div className="leads">
                {examples.map((x) => <button key={x} className="lead" onClick={() => open(x)} disabled={running}>{x.replace(/\?$/, "")}</button>)}
              </div>
            </div>
            <figure className="photo">
              <span className="paperclip" />
              <img src="/scene/caseroom-1200.webp" alt="The Causa case room in Lagos" />
              <span className="stamp supported" style={{ position: "absolute" }}>Every claim cited</span>
              <figcaption><span>Fig. 1 — the case room, Lagos</span><span>Zetaris · Meterless · Nemotron</span></figcaption>
            </figure>
          </div>
        </div>
      </header>

      <main className="wrap">
        <section className="section" id="case" ref={caseRef}>
          <div className="section__head">
            <span className="label"><span className="n">File 01</span>The case</span>
            <h2>{opened ? (v.premise ? `${v.premise.metric[0].toUpperCase()}${v.premise.metric.slice(1)}, ${Object.values(v.premise.filters).filter(Boolean).join(" · ") || "all cities"}` : "Opening the file…") : "No case open."}</h2>
            <p>{opened ? `“${question}”` : "Ask a question above. The firm measures the change, then types up one exhibit per explanation and stamps each confirmed or ruled out, against the ERP, warehouse, ad platform, price book, helpdesk and logistics systems."}</p>
          </div>

          <div className="case">
            <div className="sheet">
              <div className="sheet__h"><span>Personnel on the case</span><span>{running ? "on duty" : result ? "closed" : "standing by"}</span></div>
              <div className="sheet__b staff">
                {STAFF.map((a) => {
                  const e = v.lastBy.get(a.name);
                  const on = running && v.last?.agent_name === a.name;
                  const next = running && !on && v.last?.target_agent === a.name;
                  return (
                    <div key={a.name} className={`idc ${a.wide ? "wide" : ""} ${on ? "on" : next ? "next" : ""}`}>
                      <span className="pin" />
                      {on && <span className="typing">typing</span>}
                      <div className="idc__ph"><img src={`/cast/${a.key}-${pose(a.name)}.webp`} alt={`${a.name}, ${pose(a.name)}`} /></div>
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

            <div>
              {brief && (
                <article className="memo">
                  <span className={`stamp ${confirmed ? "supported" : "inconclusive"}`}>{confirmed ? "Case closed" : "Open questions"}</span>
                  <div className="memo__lh"><b>Causa</b><span>Memorandum</span></div>
                  <dl className="memo__meta">
                    <dt>To</dt><dd>Kòlá Foods management</dd>
                    <dt>Re</dt><dd>{question}</dd>
                    <dt>Case</dt><dd>{caseNo(result.run_id)} · {today}</dd>
                  </dl>
                  <h2>{brief.headline}</h2>
                  <p className="memo__sum">{brief.summary}</p>
                  {brief.premise_note && <p className="memo__sum" style={{ marginTop: 10 }}><b>Premise check:</b> {brief.premise_note}</p>}
                  {result.output.recommendations?.length > 0 && <ul className="recs">{result.output.recommendations.map((r: string) => <li key={r}>{r}</li>)}</ul>}
                  {brief.caveats?.map((c: string) => <p className="memo__cav" key={c}>{c}</p>)}
                  <div className="memo__foot">
                    <span>{brief.causes.length} causes · {brief.ruled_out.length} ruled out</span>
                    <span>{v.queries.size} queries · {result.execution_time_seconds}s</span>
                    <span>typed by {brief.written_by === "model" ? "Nemotron Ultra" : "the firm's rules"}</span>
                    <a className="btn sm paper" href={`data:application/json,${encodeURIComponent(JSON.stringify(result, null, 2))}`} download={`causa-${result.run_id}.json`}>File copy (JSON)</a>
                  </div>
                </article>
              )}
              {result?.status === "declined" && (
                <article className="memo declined"><span className="stamp refuted">Refused</span><div className="memo__lh"><b>Causa</b><span>Intake notice</span></div><h2>{result.output.summary}</h2></article>
              )}

              <div className="sheet">
                <div className="sheet__h"><span>Exhibits · World Model case file</span><span>{v.hyps.filter((h) => h.status !== "open").length} of {v.hyps.length} stamped</span></div>
                <div className="sheet__b">
                  {v.premise ? (
                    <div className="change">
                      <span className={`change__n ${v.premise.premise.change < 0 ? "down" : "up"}`}>
                        {v.premise.premise.changePct === null ? "n/a" : `${v.premise.premise.changePct > 0 ? "+" : "−"}${Math.abs(v.premise.premise.changePct * 100).toFixed(1)}%`}
                      </span>
                      <div className="change__what">
                        <b>{fmt(v.premise.premise.baseline, v.premise.unit)} → {fmt(v.premise.premise.target, v.premise.unit)}</b>
                        <span>{month(v.premise.baseline_month)} → {month(v.premise.target_month)}</span>
                      </div>
                      <span style={{ flex: 1 }} />
                      <button className="evtag" onClick={() => setDrawer(v.queries.get(v.premise.queryId) ?? null)}>measured · {v.premise.queryId}</button>
                    </div>
                  ) : (
                    <p className="empty">{running ? "Intake is reading the question and signing the contract…" : "The exhibits will be typed up here."}</p>
                  )}
                  {v.premiseNote && <div className="note">{v.premiseNote}</div>}
                  <div className="exhibits">
                    {v.hyps.map((h) => (
                      <article className={`ex ${h.status}`} key={h.id}>
                        <span className={`stamp ${h.status}`}>{STAMP[h.status] ?? h.status}</span>
                        <div className="ex__k">Exhibit {h.id} · {h.kind.replace(/_/g, " ")}</div>
                        <h4>{h.statement}</h4>
                        {h.finding && <p>{h.finding}</p>}
                        {h.status === "supported" && typeof h.share === "number" && !DESCRIPTIVE.includes(h.kind) && (
                          <div className="weight"><span>weight ≈ {Math.round(h.share * 100)}%</span><span className="weight__bar"><i style={{ width: `${Math.round(h.share * 100)}%` }} /></span></div>
                        )}
                        {h.evidence.length > 0 && (
                          <div className="evid">{h.evidence.map((q) => <button key={q} className="evtag" onClick={() => setDrawer(v.queries.get(q) ?? null)}>{q} · {v.queries.get(q)?.source ?? "zetaris"}</button>)}</div>
                        )}
                      </article>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gap: 22 }}>
              <div className="receipt">
                <div className="receipt__h">CAUSA</div>
                <div className="receipt__s">CFO · cost of this case · {result?.run_id ? caseNo(result.run_id) : running ? "running" : "no case"}</div>
                {[
                  ["Rounds", v.rounds, v.quote?.maxRounds],
                  ["Zetaris queries", v.queries.size, v.quote?.maxQueries],
                  ["Nemotron calls", result?.cost?.spent?.modelCalls ?? v.modelCalls, v.quote?.maxModelCalls],
                ].map(([l, used, cap]) => (
                  <div className="ln" key={String(l)}>
                    <span>{l}</span><span>{used as number}/{cap ?? "–"}</span>
                    <span className="bar"><i style={{ width: cap ? `${Math.min(100, ((used as number) / (cap as number)) * 100)}%` : "0%" }} /></span>
                  </div>
                ))}
                <div className="eng"><b>Scout Intent</b><span>{v.contract ? `${v.contract.intent.primary.split(".")[1]} · risk ${v.contract.risk.level}` : "–"}</span></div>
                <div className="eng"><b>H-MEM</b><span>{result?.engines?.hmem ?? "–"}</span></div>
                <div className="eng"><b>World Model</b><span>{result?.engines?.world_model ?? (v.hyps.length ? "file open" : "–")}</span></div>
                <div className="eng"><b>Markovian</b><span>{result?.engines?.markovian?.split(",")[0] ?? (v.rounds ? `step ${v.rounds}` : "–")}</span></div>
                <div className="receipt__t">{result ? "** paid in evidence **" : "— within budget —"}</div>
              </div>

              <div className="sheet">
                <div className="tabs">
                  <button className={tab === "log" ? "on" : ""} onClick={() => setTab("log")}>Case log</button>
                  <button className={tab === "memory" ? "on" : ""} onClick={() => setTab("memory")}>Archive</button>
                </div>
                <div className="sheet__b">
                  {tab === "log" ? (
                    <div className="log">
                      {events.length === 0 && <p className="empty">Every action is logged here as it happens, and in logs/trace-&lt;run&gt;.jsonl.</p>}
                      {[...events].reverse().map((e, i) => (
                        <div key={i} className={`s-${e.status}`}>
                          <span className="a">{e.timestamp.slice(11, 19)} {e.agent_name}</span>{e.target_agent ? ` → ${e.target_agent}` : ""} · {e.action.replace(/_/g, " ")}{e.model ? ` [${e.model.replace("nvidia/", "")}]` : ""}
                          <br />{e.output_summary.slice(0, 200)}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Archive memory={memory} />
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="method">
          <div className="section__head">
            <span className="label"><span className="n">File 02</span>Method</span>
            <h2>Four steps. Nothing taken on faith.</h2>
          </div>
          <div className="steps">
            {[
              { n: "Step 1", a: ["intake-examine", "cfo-examine"], h: "Signed, then quoted", p: "Intake turns the question into a signed contract and refuses anything that tries to change data or rewrite the agents' instructions. The CFO quotes the job and stops spend at the cap.", e: "Scout Intent" },
              { n: "Step 2", a: ["planner-examine", "investigator-examine"], h: "Rival explanations, tested", p: "The Planner lists competing causes, starting from what the firm already knows. The Investigator tests each with SQL across the client's systems through Zetaris.", e: "Zetaris · Markovian" },
              { n: "Step 3", a: ["skeptic-examine"], h: "The Skeptic objects", p: "Every finding is judged from the rows. When the model and the numbers disagree, she makes it reconsider, and demands follow-up evidence before anything is stamped.", e: "World Model · Nemotron" },
              { n: "Step 4", a: ["writer-desk", "archivist-examine"], h: "Typed up and filed", p: "The Writer types what happened, what it wasn't and what is still unknown, each claim footnoted to its query. The Archivist files the verdicts so the next case starts ahead.", e: "H-MEM" },
            ].map((s) => (
              <div className="step" key={s.n} data-tab={s.n.toUpperCase()}>
                <div className="step__art">{s.a.map((x) => <img key={x} src={`/cast/${x}.webp`} alt="" />)}</div>
                <h3>{s.h}</h3>
                <p>{s.p}</p>
                <span className="eng-tag">{s.e}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="section" id="archive">
          <div className="section__head">
            <span className="label"><span className="n">File 03</span>Archive</span>
            <h2>Every verdict is filed with its evidence.</h2>
            <p>Findings go into H-MEM with provenance: the Zetaris queries that proved them. The next question about the same business starts from here and skips what was already ruled out.</p>
          </div>
          <div className="sheet"><div className="sheet__b"><Archive memory={memory.slice(0, 12)} /></div></div>
        </section>

        <section className="section">
          <div className="section__head">
            <span className="label"><span className="n">File 04</span>Sources</span>
            <h2>Where the evidence comes from.</h2>
          </div>
          <div className="stack">
            {[
              { s: "Data", h: "Zetaris", p: "One SQL access point over the client's six systems, each registered as a REST table. Every exhibit is a Zetaris query you can open." },
              { s: "Engines", h: "Meterless", p: "Scout Intent signs every job, H-MEM remembers, the World Model holds the shared case file, Markovian keeps rounds bounded. Nightshift serves the models." },
              { s: "Reasoning", h: "NVIDIA Nemotron", p: "Nemotron 3 Ultra plans, judges and types the memo. Nemotron 3.5 Lightning binds parameters and writes the SQL. Both run through Nightshift." },
            ].map((x) => <div className="icard" key={x.h}><small>{x.s}</small><h3>{x.h}</h3><p>{x.p}</p></div>)}
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="foot__in">
          <div>
            <span className="logo__word">Causa</span>
            <p>The analyst firm that tells you why. Built for the Open Agent Hackathon 2026, track 2: The Agent That Can Explain Why. Kòlá Foods is fictional; its records are synthetic.</p>
          </div>
          <div>
            <h5>For judges</h5>
            <a href="https://github.com/neromtoobad/causa" target="_blank" rel="noreferrer">Source on GitHub ↗</a>
            <a href="/api/health" target="_blank" rel="noreferrer">Health ↗</a>
            <a href="#case">POST /run</a>
          </div>
          <div>
            <h5>The file</h5>
            <a href="#case">The case</a>
            <a href="#method">Method</a>
            <a href="#archive">Archive</a>
          </div>
          <div className="foot__base"><span>© 2026 Causa</span><span>Every claim cited</span></div>
        </div>
      </footer>

      {drawer && (
        <div className="drawer-bg" onClick={() => setDrawer(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <button className="btn sm paper x" onClick={() => setDrawer(null)}>Close ✕</button>
            <span className="label"><span className="n">Evidence</span>Printout</span>
            <h4>{drawer.queryId}</h4>
            <p className="muted" style={{ marginBottom: 12, fontSize: 14 }}>Ran on {drawer.source === "live" ? "Zetaris (live)" : drawer.source === "cache" ? "Zetaris (recorded result)" : "the local mirror of the same tables (sample mode)"}</p>
            <pre>{drawer.sql}</pre>
            <table className="rows">
              <thead><tr>{drawer.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{drawer.rows.map((r, i) => <tr key={i}>{r.map((x, j) => <td key={j}>{cell(x)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

// Zetaris returns numbers as strings ("2.1084E7"); show them as numbers.
function cell(x: unknown): string {
  const n = typeof x === "number" ? x : typeof x === "string" && /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(x.trim()) ? Number(x) : null;
  if (n === null || !Number.isFinite(n)) return String(x);
  return Number.isInteger(n) ? n.toLocaleString("en-GB") : n.toLocaleString("en-GB", { maximumFractionDigits: 2 });
}

function Archive({ memory }: { memory: any[] }) {
  if (!memory.length) return <p className="empty">Nothing filed yet. Verdicts from closed cases land here with their evidence.</p>;
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
