# Causa — the analyst firm that tells you *why*

**Open Agent Hackathon 2026 · Track 2: The Agent That Can Explain Why**

Every business owner eventually stares at a number and asks *why did that happen?* Lagos revenue fell 12.7% last month. Abuja's helpdesk tickets doubled. The answer is somewhere across the ERP, the warehouse system, the ad platform, the price book, the helpdesk and the logistics tracker, and pulling it together takes an analyst two days.

Causa is a small firm of AI analysts you can hire for that question. You ask in plain words. Seven agents measure the change, propose competing explanations, test each one against the client's own systems **through Zetaris**, argue over the evidence, and hand back a brief where **every claim links to the exact SQL and rows behind it**, including what was ruled out and what remains unknown.

> Example: *"Why did Lagos revenue fall in August 2026?"*
> **Brief:** Lagos revenue fell 12.7% because Chin-Chin 250g was out of stock for 13 days in the Lagos warehouse (≈98% of the drop; sales of that SKU fell 37–43% in every channel), and a 15% Plantain Chips price rise cut its volume by about a fifth (≈13%). Ruled out: marketing (ad spend actually rose 0.8%) and seasonality (the same months a year earlier moved +0.4%).

Demo client: **Kòlá Foods**, a fictional Lagos snack distributor. Its data is **synthetic** (see [Data](#data)).

---

## Quick start

### 1. No credentials at all (judges start here)

```bash
docker build -t causa .
docker run --rm -p 8000:8000 -e SAMPLE_MODE=true causa
# open http://localhost:8000, or:
curl -X POST http://localhost:8000/run -H "Content-Type: application/json" -d @input_examples/example_1.json
```

`SAMPLE_MODE=true` runs the **real agent logic** with no keys. Zetaris answers come from recorded live results (`data/cache/`) or, for queries never recorded, from a local DuckDB mirror of the same seven tables. Agents reason with the firm's deterministic playbook instead of Nemotron. Your own questions work too, not just the shipped examples.

### 2. Full stack (Zetaris + Meterless Nightshift + Nemotron)

```bash
cp .env.example .env          # fill in METERLESS_RUNTIME_TOKEN and ZETARIS_API_KEY
docker build -t causa .
docker run --rm -p 8000:8000 --env-file .env --add-host=host.docker.internal:host-gateway \
  -e METERLESS_BASE_URL=http://host.docker.internal:8088/v1 \
  -e ZETARIS_REST_URL=http://host.docker.internal:8888/api/v1.0 causa
# register the client's systems in Zetaris (once):
npx tsx --env-file=.env scripts/zetaris-setup.ts
```

Prerequisites, per the hackathon setup guide:

| Layer | What | Notes |
|---|---|---|
| Data | Zetaris running locally in Docker (`localhost:8888`) | API key created in the Zetaris UI → `ZETARIS_API_KEY` |
| Power | Meterless **Nightshift** running (`127.0.0.1:8088`) | Runtime token from Nightshift → Console → `METERLESS_RUNTIME_TOKEN`. The NVIDIA key lives in Nightshift's Providers tab, never in this app |
| Models | Nemotron lanes via Nightshift | `METERLESS_MODEL_FAST=nvidia/nemotron-3.5-lightning-30b-a3b`, `METERLESS_MODEL_DEEP=nvidia/nemotron-3-ultra-550b-a55b` |

### 3. Without Docker

```bash
npm ci
npm run build                      # builds the office UI into web/dist
npm start                          # API + UI on :8000  (add --env-file=.env via: npx tsx --env-file=.env src/server.ts)
npx tsx src/cli.ts input_examples/example_1.json      # one run from the CLI, JSON to stdout
npm test                           # engine conformance smoke tests + Causa feature tests
```

---

## Usage

**HTTP** — `POST /run` takes JSON and returns JSON:

```json
{ "run_id": "demo-001", "input": { "query": "Why did Lagos revenue fall in August 2026?" }, "options": { "sample_mode": false } }
```

Returns `status`, `output.summary`, `output.brief` (headline, the measured change, `causes[]` each with `evidence[]` = `{queryId, sql, source, rows}`, `ruled_out[]`, `unresolved[]`, caveats), `output.recommendations`, `agents`, `contract` (the signed Scout Intent contract and its lineage), `memory`, `engines`, `cost` (the CFO's quote and spend), `trace_id`, `log_file` and `execution_time_seconds`. Failures return a structured `error` instead of crashing.

**UI** — `http://localhost:8000`: every question opens a case file. The personnel ID cards change pose as each agent works, each hypothesis is typed up as an exhibit and rubber-stamped *confirmed* or *ruled out*, every evidence tag opens the SQL and rows, the CFO's cost of the case prints as a till receipt, the answer arrives as a typed memorandum, and the case log streams live.

Other endpoints: `POST /api/jobs` + `GET /api/jobs/:id/events` (live SSE trace), `GET /api/health`, `GET /api/memory` (what the firm remembers).

**Examples** — `input_examples/` (3 inputs) and `output_examples/` (their outputs from real runs). Try your own: *"Why did Port Harcourt revenue change in November 2025?"*, *"Why did Abuja late deliveries rise in September 2026?"*, *"Why did Lagos units fall in August 2026?"*

---

## How it works

```
question
   │
   ▼
Intake ── Meterless Scout Intent: Sense → Interpret → Guard → Route → signed ExecutionContract
   │        (injection / write requests are blocked here; nothing downstream acts on raw text)
   ▼
CFO ── quotes the job: rounds, Zetaris queries, model calls, seconds. Denies spend past the quote.
   │
   ▼
Archivist ── Meterless H-MEM recall: what the firm already learned about this business
   │
   ▼
Investigator ── measures the change through Zetaris; Skeptic checks the question's premise
   │
   ▼  ┌──────────── Meterless Markovian: each round is one bounded step; the hypothesis ledger is the carryover ───────────┐
   │  │  Planner (Nemotron Ultra) proposes competing hypotheses (+ playbook coverage, minus what memory already ruled out) │
   │  │  Investigator tests each with SQL through Zetaris (Nemotron Lightning writes/repairs custom queries)               │
   │  │  Skeptic judges each from the rows, disputes the model when the numbers disagree, demands follow-up evidence      │
   │  │  Planner re-plans if too much of the change is still unexplained                                                    │
   │  └─────── every agent reads/writes the shared case file: Meterless World Model (single-writer event log) ──────────┘
   ▼
Writer (Nemotron Ultra) ── evidence-linked brief: causes with shares, ruled out, unresolved, caveats
   │
   ▼
Archivist ── Meterless H-MEM store: findings with provenance (the query ids that proved them)
```

### The agents

| Agent | Role | Model lane |
|---|---|---|
| **Intake** | Scout Intent pipeline; issues the HMAC-signed execution contract every tool call is verified against | rules (+ Lightning for parameter binding) |
| **CFO** | Quotes each job and enforces the budget; escalates instead of overspending | rules |
| **Archivist** | H-MEM firm memory (recall/store) and the World Model case file | — |
| **Planner** | Competing, testable hypotheses, ranked; re-plans when the explanation has gaps | Nemotron Ultra (deep) |
| **Investigator** | SQL through Zetaris; repairs failing queries with the error message | Nemotron Lightning (fast) |
| **Skeptic** | Verdicts from rows; reconciles model vs numbers; demands follow-ups | Nemotron Ultra (deep) |
| **Writer** | The client brief | Nemotron Ultra (deep) |

What makes the collaboration real rather than a fixed chain (all visible in `logs/trace-<run_id>.jsonl`):

- **Dispute loop.** The Skeptic computes its own numeric reading of the rows. When Nemotron's verdict disagrees, it sends the numbers back and makes the model reconsider. A disagreement that survives is reported as *inconclusive*, never papered over.
- **Follow-up loop.** A supply-side cause ("stockout") is not accepted until the Investigator brings sales of that SKU by channel. That's a second Markovian round.
- **Premise check.** If you ask "why did X fall" and it rose, the Skeptic says so first.
- **Re-planning.** If confirmed causes explain under 65% of the change, the Planner proposes new hypotheses for the remainder.
- **Memory.** A second question about the same business recalls earlier findings and skips tests already ruled out (fewer queries; covered by a test).
- **Budget.** The CFO denies spend past the quote; the run finishes with the evidence it has and says so.
- **Fallbacks.** Deep-lane timeouts drop to the fast lane; an unreachable provider drops to deterministic reasoning; an unreachable Zetaris drops to recorded results or the mirror. Every switch is traced.

---

## Sponsor technology

### Zetaris — the data layer (required)

Zetaris is the single access point to the client's six systems. `scripts/zetaris-setup.ts` registers each as a **Lightning REST table** (`CREATE LIGHTNING REST TABLE … FROM KOLA_SYSTEMS REQUEST(endpoint …)`) pointing at the system's JSON API (served by Causa at `/sources/<system>.json`, the way each real tool would expose its own API). A **SchemaStore view** flattens it with `LATERAL VIEW explode()`, so the agents see `kola.erp_sales`, `kola.warehouse_inventory`, `kola.ad_platform`, `kola.price_book`, `kola.helpdesk`, `kola.logistics` and `kola.product_catalog`. Every piece of evidence in a brief is a Zetaris query over its REST API (`POST /sql-editor/sqls/run`), cross-system joins included. The query id in the brief *is* the evidence handle. Code: `src/adapters/zetaris.ts`, `src/sources.ts`, `scripts/zetaris-setup.ts`.

### Meterless — engines (required) and Nightshift (Power rule)

All four engines are implemented in working features, with tests (`npm test`):

| Engine | Where | What it does in Causa | Proof |
|---|---|---|---|
| **Scout Intent** | `src/agents/intake.ts` | Intent registry + Stage-1 lexical scoring with canonical confidence bands, parameter binding, five-layer Guard (injection, write actions, out-of-estate data, PII, period), capability route, **HMAC-signed execution contract** (5-min TTL) verified before every Zetaris query, refreshed per Markovian round with `parentId` lineage | `test/features.test.ts` → tamper/expiry/scope refused; injection and write requests declined with 0 queries |
| **H-MEM** | `src/agents/archivist.ts` | Firm memory: each verdict is stored with provenance (`refs` = Zetaris query ids, `label` = the run); the Planner recalls it and skips hypotheses already ruled out for the same scope and period | test: the second run recalls the first and needs fewer queries |
| **World Model** | `src/agents/archivist.ts` | Shared case file: hypotheses, verdicts and evidence edges written by the Investigator and Skeptic in parallel; the single-writer queue keeps concurrent writes intact; the event log feeds the office view | test: 24 concurrent writes, no lost updates |
| **Markovian** | `src/run.ts` | Investigation rounds as bounded steps with a compact hypothesis-ledger carryover; `maxChunks` = the CFO's round quota | test: rounds never exceed the quote |

The engine reference implementations are vendored under `engines/` (Apache-2.0, unchanged) and their upstream smoke suites run in `npm test` (30 tests).

**Nightshift** is Causa's primary AI provider, implemented to the Meterless Runtime 0.90.0 contract (`src/adapters/meterless.ts`): URL normalisation, Bearer runtime token, `meterless-app` / `meterless-scope` headers, `GET /v1/models` for status (401/403 → unauthorized), and a 180 s timeout. `/api/health` reports the live status.

### NVIDIA — Nemotron through Nightshift

Nemotron does the reasoning: **Nemotron 3 Ultra 550B** (deep lane) plans hypotheses, judges evidence and writes the brief; **Nemotron 3.5 Lightning 30B** (fast lane) binds parameters and writes and repairs SQL. Both are served by Nightshift's NVIDIA provider; each trace line records the model that actually answered. Reasoning stays out of the answer (`detailed thinking off`) so agents get clean JSON.

### Coding tool

Built with **Claude Code**. The organisers made Cursor optional on 22 October 2026.

---

## AI and model usage

- **Models:** NVIDIA Nemotron 3 Ultra 550B and Nemotron 3.5 Lightning 30B, via Meterless Nightshift. No other model providers.
- **Frameworks:** none; a lightweight TypeScript stack (Hono, Vite/React, DuckDB for the offline mirror).
- **Development:** built with Claude Code (AI-assisted coding, scaffolding, debugging and docs). All code was reviewed and tested by the team.
- **Sample mode:** `SAMPLE_MODE=true` uses recorded Zetaris results / the local mirror and the deterministic playbook. No model calls, no network.
- **Data:** synthetic, generated by `scripts/gen-data.ts` (seeded, reproducible).
- **Art:** the case-room scene and the seven analysts (`web/public/scene`, `web/public/cast`) were generated with Higgsfield (Nano Banana Pro) during the build window, then cut out and sliced locally. Each pose maps to a live agent state (idle, working, examining, approved).

## Data

Kòlá Foods and its numbers are **fictional**. `scripts/gen-data.ts` generates 21 months (Jan 2025–Sep 2026) of monthly data for four cities, three channels and six SKUs, with three planted stories the agents are never told about (a Lagos stockout plus a price rise; a new Abuja logistics carrier; Accra Meta spend), plus red herrings. No personal data. Regenerate with `npx tsx scripts/gen-data.ts`.

## Repository

```
src/
  run.ts               one job end to end (the orchestrator)
  server.ts            HTTP API + UI host + /sources for Zetaris
  cli.ts               CLI entry
  agents/              intake (Scout Intent) · cfo · planner · investigator · skeptic · writer · archivist (H-MEM + World Model)
  adapters/            zetaris (REST) · meterless (Nightshift) · mirror (DuckDB, sample mode)
  playbook.ts          typed hypothesis tests + numeric rules
  sources.ts           the client's systems: Zetaris DDL, mirror and planner schema from one definition
engines/               Meterless reference engines (vendored, Apache-2.0) + their tests
web/                   office UI (Vite + React)
scripts/               gen-data · zetaris-setup · probe
input_examples/ output_examples/ logs/ test/
```

## Limitations (honest)

- The data is synthetic and monthly. Real estates are messier; the playbook's thresholds (e.g. "5+ stockout days") are tuned for this demo.
- Causes like marketing are supported by direction and timing, not a measured share; the brief says so.
- Explaining *why* here means attribution across the systems Causa can see, not causal inference with controls.
- Model verdicts vary run to run; the numeric reading and the coverage floor keep the conclusions stable, and disagreements surface as *inconclusive*.
- Zetaris runs locally for the hackathon; the REST sources are served by Causa itself to stand in for each system's API.

## Pre-existing components (declared)

- Meterless engine reference implementations (`engines/`), unchanged, Apache-2.0.
- Syncly's character sheet and building art (the author's earlier project) were used only as style references when generating Causa's art. Causa's own visual identity is a case dossier (manila folders, typed exhibits, rubber stamps, a typed memorandum). No code was reused.

## Third-party licences

Hono (MIT) · @hono/node-server (MIT) · DuckDB node API (MIT) · React (MIT) · Vite (MIT) · Meterless engines (Apache-2.0) · Fraunces, Courier Prime, Special Elite (SIL OFL).
