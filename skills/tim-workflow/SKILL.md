---
name: tim-workflow
description: Use when orchestrating multi-agent tasks with tim — understanding how explorer, riset, and tukang work together
---

# Tim Workflow

## Overview

Tim orchestrates three specialized agents that work in parallel. Each agent has a focused role and produces output consumed by the next stage.

## Agent Roles

| Agent | Role | Output consumed by |
|-------|------|--------------------|
| 🔍 **explorer** | Maps the codebase, finds relevant files and patterns | tukang |
| 🌐 **riset** | Researches best practices, finds pitfalls | tukang |
| 🔨 **tukang** | Implements using explorer + riset context | user |
| 📋 **planner** | Splits big tasks into independent subtasks | explorer, riset, tukang |

## Modes

### `build` — normal tasks
```
scope-split (code, instant)
    ↓
explorer × N  +  riset  (parallel)
    ↓
tukang
```
Use for most tasks. Explorer fans out across codebase areas automatically.

### `build-parallel` — big tasks
```
planner (splits into subtasks)
    ↓
explorer × N  +  riset × N  (parallel per subtask)
    ↓
tukang × N  (parallel per subtask)
```
Use when the task touches multiple independent areas (e.g., "refactor entire auth system").

### `plan` — research only, no implementation
```
explorer × N  +  riset  (parallel)
    ↓
structured summary (no tukang)
```
Use to understand before committing to implementation.

## Commands

```
/tim <task>           → build mode
/tim-models           → show current model per agent
/tim-set-riset        → pick model for riset (popup)
/tim-set-tukang       → pick model for tukang (popup)
/tim-set-planner      → pick model for planner (popup)
```

## Model Strategy

Match model to role complexity:

| Agent | Recommended | Why |
|-------|-------------|-----|
| explorer | fast/cheap (haiku, flash) | Mechanical file reading, no reasoning needed |
| riset | fast/cheap (haiku, flash) | Web search + summarize, not complex reasoning |
| tukang | best available (sonnet, gpt-4o) | Needs judgment, writes actual code |
| planner | standard (sonnet) | Needs to understand task structure |

## When to Use Each Mode

```
Task touches 1–3 files, clear scope?
  → /tim build

Task touches many areas, complex?
  → Use tim with mode="build-parallel"

Need only codebase exploration?
  → Use tim with mode="explore"

Need only research?
  → Use tim with mode="research"
```

## Output Flow

Explorer output format (consumed by tukang):
```
## Relevant Files
## Key Patterns
## Potential Impact Areas
## Gaps / Unknowns
```

Riset output format (consumed by tukang):
```
## Recommended Approach
## Key Patterns to Follow
## Pitfalls to Avoid
## Security Considerations
## References
```

Tukang receives both and produces:
```
## Changes Made
## Tests
## Notes
```

## Red Flags

- Explorer running 15+ turns → task scope too broad, use `build-parallel`
- Tukang asking questions about the codebase → explorer output was insufficient
- Tukang ignoring riset recommendations → riset output wasn't specific enough
- All agents failing → check model API keys with `/tim-models`
