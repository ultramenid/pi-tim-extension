# Tim — Parallel Subagent Orchestrator for Pi

Tim is a Pi extension that breaks development tasks into parallel workstreams, delegating to specialized subagents that run concurrently.

## ⚠️ Important: Model Quality Matters

Tim relies on the active LLM to correctly invoke the `tim` tool with the right parameters. **Weak or cheap models may:**
- Call the wrong mode (e.g., `explore` instead of `plan`)
- Show the tool parameters as text instead of actually calling the tool
- Produce poor codebase analysis or incomplete implementations

**If tim behaves unexpectedly, the first thing to check is your active model.** Use a capable model (Claude Sonnet, GPT-4o or equivalent) as your main Pi model. The orchestrating LLM should be strong.

---

## Agents

| Agent | Role | Tools |
|-------|------|-------|
| 📋 **planner** | Explores codebase, splits task into subtasks | `read, ls, grep, find` (read-only) |
| 🔨 **tukang** | Implements — writes, edits, fixes code | Full access: `read, write, edit, bash, grep, ls, find` |
| 🌐 **riset** | Researches best practices via web | Full access (needs `bash`/`curl` for web lookups) |

Each agent runs as an isolated `pi` subprocess with its own context window. Tool allowlists are enforced at the subprocess level via `--tools` — a read-only agent literally cannot call `edit` or `bash` even if the model tries.

---

## How It Works

### `build` — normal tasks

```
📋 planner  →  🔨 tukang×N  ──(parallel)──→  done
```

Planner explores the codebase, understands the task, then splits into subtasks based on complexity — 1 tukang for simple tasks, N tukang in parallel for complex ones.

### `build-parallel` — big tasks

```
📋 planner  →  🔨 tukang×N  ──(parallel)──→  done
```

Same as `build`.

### Other modes

| Mode | What runs |
|------|-----------|
| `explore` | planner explores only (no implementation) |
| `research` | riset[] (parallel web research, no codebase reading) |
| `implement` | tukang only (you provide context) |
| `chain` | custom sequential steps with `{previous}` placeholder |

---

## Installation

### Via Pi (recommended)

```bash
pi install git:github.com/ultramenid/pi-tim-extension
```

Then reload: `/reload`

### Manual

```bash
git clone https://github.com/ultramenid/pi-tim-extension ~/.pi/agent/extensions/tim
```

Then reload: `/reload`

### Structure

```
tim/
├── package.json
├── README.md
├── extensions/
│   └── index.ts          ← extension entry point
│   ├── agents/
│   │   ├── config.json       ← per-agent model overrides (auto-managed)
│   │   ├── tukang.md
│   │   ├── planner.md
│   │   └── riset.md          ← available for chain mode
└── skills/
    ├── codebase-exploration/
    ├── implementation/
    ├── test-driven-development/
    ├── verification-before-completion/
    └── tim-workflow/
```

---

## Commands

| Command | Description |
|---------|-------------|
| `/tim <task>` | Run `build` mode |
| `/tim-riset <task>` | Run parallel web research across scopes |
| `/tim-init` | Generate `PROJECT_STRUCTURE.md` (optional, speeds up planner) |
| `/tim-models` | Show current model for each agent |
| `/tim-set-tukang` | Pick model for 🔨 tukang |
| `/tim-set-planner` | Pick model for 📋 planner |

Pass a model name directly to skip the picker: `/tim-set-tukang claude-sonnet-4-5`

---

## Workflow

The `build` mode pipeline:

```
📋 planner                  ← explores codebase, splits into subtasks (1 for simple, N for complex)
      ↓
🔨 tukang×N                 ← implements each subtask in parallel
      ↓
done
```

---

## Usage

### Slash command

```
/tim add authentication to the user API
```

### Tell the LLM directly

```
Use tim with mode="build" and task="add pagination to the posts endpoint"
```

```
Use tim with mode="build-parallel" and task="refactor the entire auth system to use JWT"
```

### Custom chain

```
Use tim with mode="chain" and chain:
- agent: planner, task: "map the auth system"
- agent: tukang,  task: "implement refresh tokens. Context: {previous}"
```

### With extra context

```
Use tim with mode="build", task="add rate limiting", context="we use Express and Redis is already set up"
```

---

## Helping Planner (Optional)

Run `/tim-init` to generate `PROJECT_STRUCTURE.md` at the project root — a directory tree of all source files. Planner reads this first and immediately knows where everything is, reducing exploration time.

This is **optional**. Without it, planner still discovers files via `ls` and `grep`.

---

## UI

### Live status while running

```
tim: 🔍 🔍 running…
```

### Tool row

```
◌  tim  build  [████████░░░░░░░░] 1/2

  ◌ 📋 planner
      · read src/routes/auth.ts
      · grep /requireAuth/ in src/
      › splitting into 2 subtasks…

  ◌ 🔨 tukang
      thinking…
```

Each agent row shows live tool calls and AI text responses as they happen.

---

## Model Strategy

| Agent | Recommended | Why |
|-------|-------------|-----|
| 🔨 tukang | **Best** (Sonnet, GPT-4o) | Writes code, needs judgment |
| 📋 planner | **Good** (Sonnet) | Must explore and split tasks correctly |

**Recommended setup:**

```
/tim-set-tukang  → claude-sonnet-4-5
/tim-set-planner → claude-sonnet-4-5
```

---

## Token Cost

Estimates for a typical `build` task (2 scopes, no fix rounds, no retry).

| Setup | Cost |
|-------|------|
| All Sonnet | **≈ $0.30–$0.60** |
| Haiku for planner, Sonnet for tukang | **≈ $0.15–$0.35** |

> **Note:** Planner reads files during exploration, so input tokens scale with codebase size. Use `/tim-init` to generate `PROJECT_STRUCTURE.md` — planner reads this first and finds relevant files faster with fewer reads.

---

## Customizing Agents

Edit the `.md` files in `agents/` to change agent behavior. Changes take effect on the next run (no reload needed).

Agent model overrides live in `agents/config.json` — managed by the `/tim-set-*` commands or editable by hand.

To add a new agent, create `agents/myagent.md` and reference it in a `chain`. New agents default to full tool access — to make them read-only, they need to be added to the `READ_ONLY_AGENTS` map in `extensions/index.ts`.

---

## Contributing

PRs welcome. Areas that would benefit from contributions:

- More source-file extensions in `SOURCE_EXTS` (currently covers 20+ languages)
- Better scope detection for monorepo conventions not already covered
- Configurable thresholds (min files to read, retry count, file list cap) — currently hardcoded in `extensions/index.ts`
- Support for more documentation filename conventions (currently any `.md` at scope root is surfaced, but structured opt-in could be useful)

Open issues before large refactors so we can align on direction.
