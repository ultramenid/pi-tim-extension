---
name: verification-before-completion
description: Use before claiming any work is complete, fixed, or passing
---

# Verification Before Completion

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this session, you cannot claim it passes.

## The Gate

Before saying "done", "complete", "fixed", "passing", or expressing satisfaction:

```
1. IDENTIFY: What command proves this claim?
2. RUN: Execute it fresh (not from memory of a previous run)
3. READ: Full output — count failures, check exit code
4. VERIFY: Does output confirm the claim?
   - NO → state actual status with evidence
   - YES → state claim WITH evidence
```

## Common Verifications

| Claim | Required evidence |
|-------|------------------|
| Tests pass | Run test command → see 0 failures |
| Build succeeds | Run build → exit 0 |
| Bug fixed | Run test that reproduces bug → passes |
| Linter clean | Run linter → 0 errors |
| Requirements met | Re-read spec → check each item |

## Red Flags — STOP

- "Should work now" without running
- "I'm confident" — confidence ≠ evidence  
- Expressing satisfaction ("Great!", "Done!") before verification
- Trusting a previous run from earlier in the session
- Partial verification ("linter passed" ≠ tests pass)
