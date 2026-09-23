# research-agent

> An Agent / Claude / Codebuddy Skill — a three-tier multi-agent research pipeline that plans, delegates in parallel, synthesizes, and cites.

[中文说明](./README.zh-CN.md) · [SKILL.md](./SKILL.md)

---

## What it is

`research-agent` is **not** a runnable program. It is a set of three production-ready system prompts that turn any subagent-capable host (Claude with sub-agents, Codebuddy, or a compatible agentic runtime) into a research system that:

1. **Plans** a research strategy and decides how many parallel workers are needed.
2. **Delegates** fact-gathering to 1–20 research subagents running in parallel.
3. **Synthesizes** their findings into a single Markdown report.
4. **Cites** the report without changing a single character of its content.

The pipeline is deliberately strict about who does what — the lead never does primary research, subagents never write the final report, and the citations agent never edits prose.

## Architecture

```
User query
    ↓
Lead Agent        ── plans & delegates
    ↓  run_blocking_subagent (parallel, 1–20)
Research Subagents ── OODA loop, web_search / web_fetch, internal tools
    ↓  complete_task
Lead Agent        ── synthesizes report.md (no reference list)
    ↓
Citations Agent   ── wraps output in <exact_text_with_citation>
    ↓
research-<topic>/report.md  (+ attached assets)
```

## The three agents

### 1. Lead Agent — `lead-agent-prompt.md`

Owns **strategy and synthesis**. Its job is to:

- Decompose the query and classify it as **depth-first**, **breadth-first**, or **straightforward**.
- Decide how many subagents to spawn (see table below).
- Write extremely explicit task briefs for each subagent (objective, expected format, starting sources, tools to use, scope boundaries).
- Deploy subagents in parallel via `run_blocking_subagent`.
- Synthesize all returned reports into the final Markdown. **The lead writes the report itself — never delegates the write-up.**
- Save output to a dedicated folder `research-<topic>/` containing `report.md` and any attached assets (CSV, scripts, images).

**Subagent-count guidance**

| Query complexity | Subagents |
| --- | --- |
| Simple / straightforward | 1 |
| Standard | 2–3 |
| Medium | 3–5 |
| High | 5–10 (hard cap: 20) |

### 2. Research Subagent — `subagent-prompt.md`

Owns **primary research**. Runs an OODA loop (Observe → Orient → Decide → Act) within a strict **tool-call budget**:

- Simple task: < 5 calls
- Medium: ~5–10 calls
- Hard: ~10–15 calls
- **Absolute ceiling: 20 calls / ~100 sources** — beyond this the subagent is killed.

Core tool pattern: `web_search` to discover, `web_fetch` to read the full page. Internal tools (Google Drive, Gmail, GCal, Slack, Asana, GitHub, repl …) are **mandatory** when available and relevant — their presence means the user enabled them on purpose. Reports back exclusively through `complete_task`.

### 3. Citations Agent — `citations-agent-prompt.md`

Owns **attribution, nothing else**. Receives a report inside `<synthesized_text>` and returns it inside `<exact_text_with_citation>` with citations added. Rules are non-negotiable:

- Zero content changes, zero whitespace changes.
- Only cite claims directly supported by a source.
- Prefer end-of-sentence citations; never fragment sentences with adjacent redundant citations.
- Output mismatch with the original text = rejected.

## Query-type cheat sheet

| Type | Shape | Example |
| --- | --- | --- |
| **Depth-first** | One question, many angles | "What are the real causes of the 2008 financial crisis?" |
| **Breadth-first** | Many independent sub-questions | "Compare tax systems across the EU" |
| **Straightforward** | Single focused lookup | "What is the current population of Tokyo?" |

## Source-quality policy

Prefer: primary sources, recent data with concrete dates/numbers, official reports, peer-reviewed literature, government portals.

Flag or avoid: speculative future tense ("may", "might"), passive voice with anonymous attribution, marketing copy, financial projections dressed as facts, news aggregators that lose provenance, unverified reports.

When sources conflict, rank by recency, consistency with other evidence, and source quality; if irreconcilable, surface the conflict to the lead rather than pick silently.

## How to use these prompts

This repo ships **prompts**, not code. Typical wiring:

1. Load `lead-agent-prompt.md` as the system prompt of your orchestrator model. Expose a `run_blocking_subagent(prompt)` tool and a `complete_task(report)` tool.
2. Each `run_blocking_subagent` call spawns a worker whose system prompt is `subagent-prompt.md`, with `web_search` and `web_fetch` (plus any internal connectors) available.
3. After the lead emits the synthesized Markdown, pass it inside `<synthesized_text>…</synthesized_text>` to a model primed with `citations-agent-prompt.md`.
4. Persist the final `<exact_text_with_citation>` content to `research-<topic>/report.md`.

The prompts contain a Go-template placeholder `{{.CurrentDate}}` that the host should substitute before sending.

## Install

Via [skills.sh](https://skills.sh) (works for Claude Code / Cursor / Codex / CodeBuddy / OpenCode and 50+ agents):

```bash
# global install (available across all projects)
npx skills add dimayip/research-agent -g -a claude-code

# project-only install (committed with your project)
npx skills add dimayip/research-agent -a codebuddy

# list what ships in the repo without installing
npx skills add dimayip/research-agent --list
```

Or install manually: clone/drop the repo into your agent's skills directory —
e.g. `~/.claude/skills/research-agent/` or `.codebuddy/skills/research-agent/` —
and the host picks it up on next launch.

Compatible with the [Agent Skills Specification](https://agentskills.io).

## Repository layout

```
research-agent/
├── SKILL.md                      # skill entry with frontmatter (name + description)
├── lead-agent-prompt.md          # Lead Agent system prompt
├── subagent-prompt.md            # Research Subagent system prompt
├── citations-agent-prompt.md     # Citations Agent system prompt
├── README.md                     # this file
├── README.zh-CN.md               # Chinese version
└── LICENSE                       # MIT
```

## Common failure modes

| Failure | Fix |
| --- | --- |
| Lead does primary research itself | Delegate; lead plans and synthesizes only |
| Subagents repeat identical queries | Vary phrasing; broaden scope on empty results |
| Too many subagents for a trivial query | Match count to complexity; start from 1 |
| Citations agent rewrites the report | Add tags only; zero content change |
| Subagent blows past tool-call budget | Stop at 15 calls and `complete_task` immediately |
| Final report contains a "References" section | No references section in the report — citations agent handles it |

## License

[MIT](./LICENSE)
