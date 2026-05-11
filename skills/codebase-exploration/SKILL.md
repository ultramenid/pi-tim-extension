---
name: codebase-exploration
description: Use when mapping an unfamiliar codebase or scoping a specific area for a task
---

# Codebase Exploration

## Overview

Efficient exploration means reading the minimum to understand the maximum. Never read every file — read the right files.

**Core principle:** Map first, read second. Understand structure before diving into code.

## The Iron Law

```
NO DEEP FILE READING WITHOUT FIRST MAPPING THE STRUCTURE
```

Start with `ls`, `find`, and entry points. Only then read specific files.

## The Process

### Phase 1: Orient (2–3 tool calls max)

1. `ls` the root — understand top-level layout
2. Identify the type of project (API, frontend, monorepo, library)
3. Find entry points: `package.json`, `main.ts`, `app.py`, `Cargo.toml`, `Makefile`

```bash
ls -la
cat package.json   # or equivalent
```

### Phase 2: Scope to the Task

Only explore what's relevant to the task. Ask: *which directories/files could possibly be involved?*

```bash
find src -name "*.ts" | head -30          # list files, don't read yet
grep -r "functionName" src --include="*.ts" -l   # find where it's used
```

### Phase 3: Read Strategically

Read in this order:
1. **Interface/type definitions** — understand the contract
2. **Entry point for the relevant feature** — follow the call chain
3. **Implementation files** — only the ones in the call chain
4. **Tests** — they document expected behavior better than comments

**Never read:**
- `node_modules/`, `dist/`, `build/`, `.git/`
- Files clearly unrelated to the task scope
- Config files unless the task is about config

### Phase 4: Output a Structured Map

Always end with a structured summary:

```
## Relevant Files
- `src/routes/auth.ts` — entry point for auth routes
- `src/services/jwt.ts` — JWT creation/validation
- `src/middleware/auth.ts` — request auth middleware
- `src/models/user.ts` — User model with password hash

## Key Patterns
- Uses Express middleware chain
- JWT stored in httpOnly cookie
- Passwords hashed with bcrypt (cost factor 12)

## Potential Impact Areas
- Any route using `authMiddleware`
- `src/tests/auth.test.ts` — existing test coverage

## Gaps / Unknowns
- Refresh token logic not found — may not exist yet
```

## Red Flags — STOP

- Reading more than 10 files without producing output
- Reading `node_modules` or generated files
- Exploring areas unrelated to the task scope
- Spending more than 15 tool calls without a summary

## Output Contract

Your output is consumed by `tukang` (implementor). Make it actionable:

- **File paths must be exact** — tukang will open them directly
- **Patterns must be specific** — "uses Express" is useless; "uses `express-async-errors` wrapper on all route handlers" is useful
- **Flag missing pieces** — if something the task needs doesn't exist yet, say so explicitly
- **Note conventions** — naming patterns, file organization, import style

## Quick Reference

| Goal | Command |
|------|---------|
| Find all files of a type | `find src -name "*.ts" -not -path "*/node_modules/*"` |
| Find where something is used | `grep -r "symbol" src -l` |
| Understand a module's exports | `grep "^export" src/module.ts` |
| Find tests for a file | `find . -name "*.test.ts" -path "*auth*"` |
| Check recent changes | `git log --oneline -10 -- src/relevant/` |
