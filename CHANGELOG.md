# Changelog

## [1.0.0] — 2026-05-23

Initial release.

### Static analysis
- Detects Redis cache clients: `ioredis`, `redis`, `@redis/client`, `@redis/*`
- Detects queue libraries: `bullmq`, `bull`, `bee-queue`
- Cache rules: `missing-ttl`, `setnx-no-expiry`, `zero-ttl`, `negative-ttl`
- Queue rules: `queue-missing-attempts`, `queue-no-remove-on-complete`, `queue-no-remove-on-fail`, `queue-missing-timeout`, `queue-default-concurrency`, `queue-missing-stalled-interval`
- A–F grading scale based on finding severity

### Live inspection (`--live`)
- Memory: usage %, limit, eviction policy, fragmentation ratio
- Key sampling via `SCAN`: TTL coverage, idle keys, oversized keys, namespace breakdown
- Queue health: waiting / active / failed / delayed counts, stalled queue detection
- Cross-mode analysis: live data confirms or contradicts static findings

### Output & CI/CD
- Three output modes: auto-save markdown, `--output text`, `--output json`
- `--fail-on error|warn|any` — exit code 1 when static findings meet threshold
- Exit codes: 0 clean, 1 findings, 2 tool error, 3 invalid config
- `.stack-doctorrc` config file support

### Recommendations
- Prioritised action plan (Priority 1–3) with quick wins
- Live-confirmed findings promoted to Priority 1
- All findings include a concrete fix suggestion
