---
name: implementation
description: Use when implementing a feature, fix, or change based on explorer and riset context
---

# Implementation

## Overview

Good implementation follows the codebase's existing patterns, makes the minimum change needed, and verifies the result.

**Core principle:** Match the codebase. Don't invent new patterns when existing ones work.

## The Iron Law

```
NO IMPLEMENTATION WITHOUT READING THE CONTEXT PROVIDED
```

Read the explorer and riset outputs fully before writing a single line of code.

## The Process

### Phase 1: Understand Before Acting

1. **Read explorer output** — know exactly which files to touch
2. **Read riset output** — know the approach and pitfalls
3. **Identify the minimal change** — what is the smallest diff that achieves the goal?
4. **Check for existing tests** — understand what's already covered

If context is missing or contradictory → state what's missing, don't guess.

### Phase 2: Plan the Change

Before editing, write out (mentally or explicitly):

```
Files to modify:
- src/routes/auth.ts — add refresh token endpoint
- src/services/jwt.ts — add refresh token generation

Files to create:
- src/middleware/refreshToken.ts — new middleware

Files NOT to touch:
- src/models/user.ts — no schema changes needed
```

**Minimal change principle:** If you can achieve the goal by modifying 2 files instead of 5, modify 2.

### Phase 3: Implement

Follow the project's existing conventions:

- **Naming** — match existing variable/function/file naming style
- **Error handling** — use the same error pattern already in the codebase
- **Imports** — match existing import style (named vs default, path aliases)
- **Types** — add TypeScript types consistent with existing code
- **Comments** — only where the code is genuinely non-obvious

**Never:**
- Refactor unrelated code while implementing
- Add features not requested
- Change formatting/style in files you're not modifying for the task
- Add dependencies without checking if an existing one covers the need

### Phase 4: Verify

After implementing, verify before claiming done:

```bash
# Run relevant tests
npm test -- --testPathPattern="auth"

# Check types compile
npx tsc --noEmit

# Lint
npm run lint src/routes/auth.ts
```

**The verification gate:**
```
BEFORE claiming complete:
1. Run the test command → read the output
2. Count failures: must be 0
3. ONLY THEN say "done"
```

If tests fail → fix them. Don't claim done with failing tests.

### Phase 5: Output Summary

```
## Changes Made
- `src/routes/auth.ts` — added POST /auth/refresh endpoint
- `src/services/jwt.ts` — added generateRefreshToken(), verifyRefreshToken()
- `src/middleware/refreshToken.ts` — created (new file)

## Tests
- Existing: 24/24 pass
- New: added 3 tests for refresh token flow

## Notes
- Refresh tokens expire in 7d (matches existing session config)
- Used existing `AppError` class for error responses
- Did NOT implement token rotation (not in scope — flag for follow-up if needed)
```

## Red Flags — STOP

- Implementing without reading explorer/riset context
- Touching files not in the explorer's relevant files list
- Adding a new library when an existing one covers the need
- Claiming done without running tests
- Refactoring unrelated code
- Implementing features beyond the task scope

## Common Patterns

### Adding a new endpoint
1. Find existing route file for the resource
2. Copy the pattern of an existing endpoint (same error handling, same response shape)
3. Add to the router in the same style
4. Add tests mirroring existing test patterns

### Fixing a bug
1. Write a failing test that reproduces the bug first
2. Make the minimal fix
3. Verify the test passes
4. Verify no other tests broke

### Adding middleware
1. Find where existing middleware is registered
2. Follow the same registration pattern
3. Match the middleware signature style

### Database changes
1. Check if migrations exist — if yes, create a migration
2. Update the model
3. Update any affected queries
4. Test with real data shape, not just unit tests
