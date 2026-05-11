---
name: test-driven-development
description: Use when implementing any feature or bugfix — write failing test first, then implement
---

# Test-Driven Development

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write code before the test? Delete it. Start over.

## Red-Green-Refactor

### RED — Write Failing Test First
Write one minimal test that describes the desired behavior. Run it. It must fail.

```bash
npm test -- --testPathPattern="auth"   # must show FAIL
```

If the test passes immediately → you're testing existing behavior, not new behavior. Fix the test.

### GREEN — Minimal Implementation
Write the simplest code that makes the test pass. Nothing more.

```bash
npm test -- --testPathPattern="auth"   # must show PASS
```

### REFACTOR — Clean Up
Remove duplication, improve names. Keep tests green.

## For Bug Fixes

1. Write a failing test that reproduces the bug
2. Verify it fails (proves the test catches the bug)
3. Fix the bug
4. Verify the test passes
5. Verify no other tests broke

## Verification Before Completion

```
BEFORE claiming done:
1. Run full test suite
2. Read output — count failures
3. failures = 0 → done
4. failures > 0 → fix, repeat
```

## Red Flags — STOP

- Writing implementation before a failing test exists
- Test passes immediately on first run (not testing new behavior)
- Claiming done without running the full test suite
- "I'll add tests later"
- "It's too simple to test"
