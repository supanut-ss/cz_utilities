# Baton — Multi-AI Team Orchestrator Spec

Oct 22, 2026

## Overview

Baton lets one person run a team of AI agents from different providers in one web app. Agents split a goal into steps, hand work to each other, and pause for human approval.

- **Problem:** using several AIs today means copy-pasting between chat windows, with no shared context, no hand-off and no cost control.
- **Target users:** Thai knowledge workers and small teams (reports, content, research, code review) who are not prompt engineers.
- **MVP goal:** a user types a goal in plain Thai, accepts a suggested team, and gets a reviewed result with approval checkpoints. Every run shows live progress, tokens and cost.
- **Out of scope for MVP:** node-graph editor, multi-user workspaces, skill marketplace, native mobile apps.

Product principles:

1. **Suggest first, configure later.** The app proposes a team and flow; editing is optional.
2. **Human in the loop.** Agents ask when unsure, and anything that leaves the app needs approval.
3. **Hand off documents, not chat history.** Every hand-off is a structured work order.
4. **Cost is always visible.** Tokens and baht per agent, per run and per month.

"Baton" is a working name (the relay baton). The UI language is Thai.

## Screens & UX

The design is 7 artboards on the [Baton design canvas](https://claude.ai/artifact/PSN85AKGtCD7mRbpgpc7vA). Screens 1–5 are linked, so you can click through them in Play mode.

| # | Screen (Thai label) | Purpose | Key elements |
| --- | --- | --- | --- |
| 1 | New task (เริ่มงานใหม่) | Start from a goal | Goal composer, templates, suggested team as a 4-stage pipeline, time and cost estimate, "ask me when unsure" toggle |
| 2 | Run (ทีมกำลังทำงาน) | Watch and steer a live run | Stage stepper, agent cards with status, progress and tokens, hand-off timeline, agent questions with answer buttons, @mention command box, latest output preview |
| 3 | Team (ตั้งค่าทีม AI) | Define agents | Agent cards (model, skills, tools, avg tokens); editor for role prompt, model tier, tool allowlist, skills, token budget, answer style |
| 4 | Flow (ลำดับงาน) | Define hand-off rules | 3 modes, stage list with drag reorder, pass/fail routing, max review rounds, approval step, team rules (budget, time, fallback, shared memory) |
| 5 | Skills library (คลังทักษะ) | Manage reusable skills | Skill list, editor (when to use, instructions, files, required tools), token cost per load level, versions, SKILL.md import |
| 6 | How it works | Concept diagram | User → orchestrator → agents → providers, with shared memory |
| 7 | Architecture | System diagram | Web, API, Redis, worker components, data stores, providers |

Core flow (happy path):

1. The user types a goal on screen 1 and presses "จัดทีมให้" (suggest a team).
2. The planner proposes agents, models and stages. The user accepts, or adjusts on screens 3 and 4.
3. "เริ่มทำงาน" (start) launches the run, and screen 2 streams progress.
4. Agents hand off work. An unsure agent posts a question with answer options.
5. The reviewer passes the work or sends it back, up to the max rounds.
6. The user approves the final output, which is saved to the run.

Visual system: IBM Plex Sans Thai with IBM Plex Mono for numbers, a cool neutral background, one blue accent (#2D5BFF), agents identified by a letter tile plus name, and 44 px minimum touch targets.

## Architecture

Every agent step is a queued job that saves its state to Postgres. Runs can wait hours for an approval, and they resume after a worker crash.

[Diagram: system architecture, 10 components. Browser (Next.js screens) ⇄ Next.js server (UI, REST, SSE, auth) ⇄ Redis (BullMQ jobs, pub/sub) ⇄ Worker (Flow engine → Context builder → LLM gateway ⇄ Tool runtime). Next.js server and Worker read/write PostgreSQL + R2. LLM gateway → AI providers (Anthropic, OpenAI, Google, Ollama). Tool runtime → external services (web search, sandbox, LINE, email).]

No worker holds a run in memory between steps. Results go to Postgres, and events reach the browser through Redis and SSE.

A run, step by step:

1. The API saves the run with a pinned flow version and enqueues the first stage.
2. A worker pulls the step, builds the context, calls the model through the gateway, and runs any tool calls.
3. The output is saved as an artifact plus a work order for the next stage. Events go to Redis.
4. The API relays those events to the browser over SSE.
5. A question or approval sets the run to waiting and ends the job. The user's answer enqueues the next step.

## Tech stack

TypeScript end to end, in one monorepo, so the UI and the engine share the same schemas.

| Layer | Choice | Why |
| --- | --- | --- |
| Repo | pnpm + Turborepo: `apps/web`, `apps/worker`, `packages/core`, `packages/llm-gateway`, `packages/tools` | Shared Zod schemas for work orders, flows and events |
| UI + API | Next.js (UI, REST route handlers, SSE), Tailwind + shadcn/ui, dnd-kit, TanStack Query | Matches the design; one deployable for UI and API |
| Live updates | Server-Sent Events; commands go over REST | One-way stream is enough; resumes from the last event id |
| Queue + events | Redis with BullMQ, plus Redis pub/sub | Retries, delayed jobs (reminders), per-provider rate limits |
| Database | PostgreSQL + Drizzle ORM; pgvector later | Runs, steps, events, costs, skills in one place |
| Files | S3-compatible storage (Cloudflare R2; MinIO in dev) | Attachments, outputs, skill files |
| LLM access | Own `LLMGateway` interface over each provider's official SDK | New features land in official SDKs first |
| Tools | MCP-style tool registry; Tavily for web search; E2B for code sandbox | Same tools for every provider |
| Auth | Auth.js with LINE Login and Google | LINE is the default login for Thai users |
| Notifications | LINE Messaging API, email via Resend | LINE Notify was discontinued in March 2025 |
| Observability | Langfuse, OpenTelemetry, Sentry | Prompt, token and error traces per step |
| Deploy | Docker: web, N workers; managed Postgres and Redis; Singapore region | Long SSE streams and long jobs rule out serverless |

## Flow engine & handoffs

The flow engine is a state machine over stored rows. Each step is one job, and waiting for a person costs no compute.

[Diagram: run states. Queued → Running → Done; Running ⇄ Waiting for you (question or approval); Running ⇄ Paused (user pressed pause); Running → Failed or stopped (error, budget, stop).]

Only Running holds a worker, and only for one step at a time; every other state is a row in Postgres.

| Mode | How the engine runs it |
| --- | --- |
| Sequential | Stages run in order; each stage receives the previous stage's work order |
| Parallel | A stage with several agents enqueues one job each; a join counter waits for all (or the first) and merges |
| Manager | A manager agent gets `delegate(agent, task)` and `finish(result)` tools; delegations run as child steps, one level deep |

Rules:

- **Review loop:** the reviewer returns a verdict. On fail, the engine creates a new step for the named agent with the issues and adds one round; at the max, it asks the user.
- **Stuck agent:** each stage has a timeout, after which the user is asked.
- **Questions:** every agent has an `ask_user(question, options)` tool. The step pauses and the run becomes Waiting for you.
- **Reminders:** a delayed BullMQ job re-notifies over LINE on the flow's schedule.

Work order passed between agents (validated with a shared Zod schema, produced through structured outputs):

```json
{
  "run_id": "run_123",
  "from": "planner",
  "to": "writer",
  "task": "Draft the report outline and introduction",
  "inputs": [{ "artifact_id": "art_9", "summary": "Brand sales table, batch 1" }],
  "expected_output": { "type": "document", "schema": "report_draft_v1" },
  "acceptance": ["Every number cites a source", "At most 2 pages"],
  "budget_tokens": 20000
}
```

Reviewer verdict:

```json
{
  "verdict": "fail",
  "issues": [{ "where": "section 2", "problem": "2025 sales figure has no source", "fix_by": "researcher" }]
}
```

## LLM gateway & models

One `LLMGateway` interface with an adapter per provider, each built on that provider's official SDK (`@anthropic-ai/sdk`, OpenAI, Google GenAI, Ollama).

- **Interface:** `generate()` (streaming), `countTokens()`, `listModels()`. The request is normalized: system, messages, tools, output schema, max tokens, effort hint.
- **Normalized response:** content, tool calls, stop reason, and usage split into input, output, cache read and cache write tokens.
- **Model list:** read from each provider's Models API at startup, never hard-coded. Context window sizes come from the same call.

Model tiers (what users pick on the Team screen):

| Tier (Thai label) | Anthropic | Other providers |
| --- | --- | --- |
| Best (เก่งที่สุด) | `claude-opus-5-5` | Set in the tier registry config |
| Balanced (สมดุล) | `claude-sonnet-5-5` | Set in the tier registry config |
| Fast and cheap (เร็วและประหยัด) | `claude-haiku-5-5` | Set in config; local models via Ollama |

Claude adapter notes:

- Get JSON work orders with structured outputs (`output_config.format`). Forced `tool_choice` returns a 400 on Opus 5.5 and Sonnet 5.5.
- Set `effort` explicitly per agent; Opus 5.5 defaults to `medium`. Thinking is adaptive and cannot be disabled on Opus 5.5.
- Check `stop_reason: "refusal"` on every response and hand it to the fallback path.
- Stream any long response. Keep the stable prompt prefix first so prompt caching works.
- Thinking blocks are tied to the model that wrote them. Never pass one agent's raw transcript to another model; pass the work order.

Fallback order: SDK retries on 429/5xx, then the same tier at another provider, then pause and ask the user. Switching model loses that agent's prompt cache, and the ledger records it.

Claude Agent SDK and Managed Agents are Claude-only, so they are not the core. A Claude-only coding agent could use them later.

## Token management

Tokens are counted before every call and capped at three levels: run, step and response.

| Level | Limit set by | When it is hit |
| --- | --- | --- |
| Run | Budget in baht (Flow screen, team rules) | Pause the run and ask the user to raise the budget or stop |
| Step | Token budget per agent step (Team screen) | Context builder trims or summarizes inputs before the call |
| Response | Max output tokens per agent (Team screen) | Model output is capped; long work continues in the next turn |

Mechanisms:

- **Count first.** Each adapter uses its provider's counter (`count_tokens` for Claude). The engine estimates cost from a price table before each call.
- **Lean context.** The context builder sends only the files a work order references. Older material is summarized by `claude-haiku-5-5`, and fetched web pages are trimmed.
- **Long tool loops.** Claude agents use compaction or context editing; other providers use our own summarizer. Claude task budgets (beta) let the model pace itself.
- **Effort.** Simple agents run at low effort; planners and reviewers run higher.
- **Prompt cache.** Order every prompt as tools, then role prompt and skill list (sorted, stable), then the task. Caches are per model, so keep each agent on one model.
- **Ledger.** Store input, output, cache-read and cache-write tokens separately per call, since each is priced differently. Screens 2 and 3 read from it.
- **Thai text.** Thai usually needs more tokens than English for the same content. Test English internal prompts and work orders with Thai final output, and keep whichever measures cheaper at equal quality.

## Skill system

A skill is a packaged how-to that an agent loads only when it needs it, so 20 attached skills cost about 1k tokens while idle.

- **Format:** a folder with `SKILL.md` (frontmatter: name, description, version, required tools; body: instructions) plus optional `files/` and `scripts/`. This matches the Agent Skills layout, so existing skills can be imported.
- **Where it lives:** skill metadata and versions in Postgres, files in object storage, managed on the Skills library screen.

Loading levels:

1. **Always in context:** name + "when to use" for each attached skill, about 50 tokens each, inside the stable prompt prefix.
2. **On demand:** the agent calls `load_skill(name)` and gets the full instructions as a tool result (about 1–2k tokens).
3. **Only what is needed:** `read_skill_file(name, path)` opens one file; `run_skill_script` runs a script in the sandbox, never in the worker.

Rules:

- **No new permissions.** Attaching a skill does not grant tools. The engine checks the agent's allowlist and the UI warns about a missing tool.
- **Pinned versions.** A run pins the skill versions it started with, like flow versions. Edits create a new version.
- **Testing.** "Test with agent" runs the skill against saved sample goals before a new version is published.
- **Imports are untrusted.** Imported skills start disabled until reviewed; their scripts run only in the sandbox.
- **Events.** Every load writes a `skill_loaded` event with its token count, shown on the Run timeline.

Claude agents could later use Anthropic's native Skills API, which requires code execution in Anthropic's container. The MVP uses our own loader so every provider behaves the same.

## Security & privacy

Safety rules are enforced in code by the engine, never left to the prompt.

- **Provider keys:** encrypted at rest with envelope encryption (AES-256-GCM, master key in a KMS). They are decrypted only in worker memory, never sent to the browser.
- **Tool permissions:** each agent has an allowlist from the Team screen. The Tool Runtime rejects any call outside it.
- **Approval gate:** email, posts, shared files and anything else leaving the app always wait for the user, whatever the model says.
- **Untrusted content:** web pages, uploaded files and imported skills are wrapped and marked as data. Instructions found inside them are never followed.
- **Code execution:** only in the E2B sandbox, with no secrets and restricted network egress.
- **Tenant isolation:** every row carries `workspace_id`, with Postgres row-level security as a second layer.
- **Audit:** `run_events` is append-only and records who or what did each action.
- **PDPA (Thailand):** show which provider receives each agent's data, offer local models for sensitive work, set a retention period per workspace, and delete run data on request.

## Data model

Eighteen core tables in PostgreSQL; every table except workspaces and `users` carries `workspace_id`.

| Table | Holds |
| --- | --- |
| `users`, `workspaces` | Accounts, LINE/Google identities, workspace settings (retention, monthly budget) |
| `provider_keys` | Encrypted API keys per provider, rate-limit settings |
| `agents` | Name, role prompt, provider, tier/model, effort, tool allowlist, step token budget, max output |
| `teams` | Named set of agents |
| `flows`, `flow_versions` | Mode, stages (agents, hand-off condition, merge rule, pass/fail routing, max rounds), team rules |
| `runs` | Goal, pinned flow version, status, budget, totals (tokens, THB), started/finished times |
| `steps` | Run, stage, agent, round, status, model actually used, input/output artifact refs, usage |
| `handoffs` | Work orders between agents: from, to, task, inputs, expected output, acceptance criteria |
| `questions` | Agent questions and approvals: options, answer, answered by, reminder schedule |
| `artifacts` | Files and outputs with versions; content in object storage |
| `run_events` | Append-only event log (seq, type, payload) for the timeline, SSE replay and audit |
| `cost_ledger` | One row per LLM call: input, output, cache-read, cache-write tokens, price, THB |
| `skills`, `skill_versions`, `skill_files` | Skill metadata, versioned instructions, attached files |
| `agent_skills` | Which skill versions each agent has attached |

## MVP plan

The MVP ships one complete report flow on two providers. Breadth comes after Gate 1 passes.

[Diagram: roadmap, 3 phases, 2 gates. Phases are ordered, not dated.
- Phase 1: MVP — Anthropic + OpenAI; sequential + parallel stages; review loop, approvals; live run screen, budgets; skill loader + library; 3 team templates.
- Gate 1: MVP exit — report run works end to end with 1 approval; resumes after a worker restart; cost within 10% of estimate.
- Phase 2: broaden — Google + Ollama; manager mode; code sandbox (E2B); LINE reminders; skill import + versions.
- Gate 2: Phase 2 exit — same flow runs on 3 providers; manager runs stay in budget; no external action unapproved.
- Phase 3: scale — long-term memory (pgvector); eval suite per template; multi-user workspaces; Temporal if load needs it.]

Durations are not set yet; estimate them once the team size is known.

MVP scope:

- [ ] Monorepo, auth (LINE + Google), workspace model
- [ ] LLM gateway with Anthropic and OpenAI adapters, tier registry, cost ledger
- [ ] Flow engine: sequential and parallel stages, review loop, `ask_user`, approvals
- [ ] Work order and verdict schemas (Zod + structured outputs)
- [ ] Screens 1–4 wired to the API, with the SSE run timeline
- [ ] Skill loader (`load_skill`, `read_skill_file`) and a basic Skills library screen
- [ ] Budgets at run, step and response level; pause when the run budget is hit
- [ ] Tools: web search, file read/write; approval gate for any external action
- [ ] Langfuse + Sentry; 3 team templates, each with sample-goal evals

## Open questions & risks

Four decisions are open before build starts:

- [ ] **Billing model:** users bring their own API keys, or the platform bills prepaid credits? This changes key storage, the ledger and payments.
- [ ] **Hosting region:** Singapore cloud region, or a Thai provider for data residency?
- [ ] **Non-Anthropic tiers:** which OpenAI and Google models fill Best / Balanced / Fast for launch?
- [ ] **Prompt language:** English or Thai for internal prompts and work orders, decided by a token and quality test.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Runaway cost in review loops or manager mode | Bills far above estimate | Run budget hard stop, max review rounds, manager delegation depth 1 |
| Provider API changes (e.g. Claude 5.5 rejecting forced tool choice) | Broken steps after an upgrade | Contract tests per adapter; pin SDK versions; Models API at startup |
| Prompt injection from web pages, files or imported skills | Data sent out, wrong actions | Approval gate on external actions, content marked untrusted, sandboxed scripts |
| Uneven quality across providers | Users blame the app | Sample-goal evals per template before changing default models |
| Approvals left unanswered | Runs stall for days | LINE reminders, timeout policy per flow, clear "waiting for you" state |
