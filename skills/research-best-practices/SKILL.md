---
name: research-best-practices
description: Use when researching patterns, libraries, or approaches for a task before implementation
---

# Research Best Practices

## Overview

Good research finds the right answer, not just an answer. Bad research finds the first answer and stops.

**Core principle:** Check local context first, then external sources. Synthesize, don't just collect.

## The Iron Law

```
NO RECOMMENDATIONS WITHOUT CHECKING THE PROJECT'S EXISTING PATTERNS FIRST
```

The best practice for *this* project is what the project already does consistently.

## The Process

### Phase 1: Check Local Context First

Before any external research:

1. **Check available skills** — a skill in your system prompt may already cover this
2. **Check the project** — what does the codebase already use for this?
3. **Check existing tests** — they reveal expected behavior and patterns

```bash
grep -r "libraryName" package.json   # is it already a dependency?
grep -r "pattern" src -l             # is it already used somewhere?
```

If the project already has a consistent pattern → **use it, don't invent a new one**.

### Phase 2: External Research (if needed)

Only go external when:
- The project has no existing pattern for this
- The existing pattern is clearly wrong/outdated
- The task explicitly requires a new approach

**Research hierarchy:**
1. Official documentation (most authoritative)
2. Security advisories / CVE databases (for security tasks)
3. Framework-specific guides (e.g., Express security best practices)
4. Community consensus (widely-adopted patterns)

**Avoid:**
- Random blog posts without verifying currency
- StackOverflow answers older than 3 years for security topics
- Anything that contradicts official docs without strong justification

### Phase 3: Evaluate Options

For each candidate approach, assess:

| Criterion | Questions |
|-----------|-----------|
| **Correctness** | Does it actually solve the problem? |
| **Security** | Any known vulnerabilities? CVEs? |
| **Compatibility** | Works with the project's stack? |
| **Maintenance** | Actively maintained? Last release? |
| **Fit** | Consistent with project conventions? |

### Phase 4: Synthesize Findings

Don't dump raw research. Synthesize into actionable recommendations:

```
## Recommended Approach
[One clear recommendation with rationale]

## Key Patterns to Follow
1. [Specific, actionable pattern]
2. [Specific, actionable pattern]

## Pitfalls to Avoid
- [Specific pitfall with why it's a problem]
- [Specific pitfall with why it's a problem]

## Security Considerations
- [If applicable]

## References
- [Official doc URL]
- [Relevant RFC/spec if applicable]
```

## Red Flags — STOP

- Recommending a new library when the project already has one for this purpose
- Citing sources older than 3 years for security-sensitive topics
- Providing 5+ options without a clear recommendation
- Recommending something that contradicts the project's existing conventions without flagging the conflict

## Output Contract

Your output is consumed by `tukang` (implementor). Make it implementable:

- **Be specific** — "use bcrypt" not "use a hashing library"
- **Include the why** — tukang needs to understand the reasoning to apply it correctly
- **Flag conflicts** — if your recommendation conflicts with existing code, say so explicitly
- **Provide examples** — a code snippet is worth 10 paragraphs of explanation

## Common Research Areas

### Security
- OWASP Top 10 for the relevant category
- Framework-specific security guides
- Check for known CVEs in dependencies: `npm audit` / `pip-audit`

### API Design
- REST conventions for the framework in use
- Existing endpoint patterns in the codebase
- Error response format already used

### Performance
- Profiling before optimizing (don't guess)
- Framework-specific optimization guides
- Database query patterns (N+1, indexing)

### Authentication
- JWT: check expiry, signing algorithm (avoid HS256 for distributed systems)
- Sessions: secure, httpOnly, sameSite cookies
- OAuth: PKCE for public clients, state parameter for CSRF
