import type { CacheAnalysisResult, FindingRule, FindingSeverity, QueueAnalysisResult } from '../types/findings.js';
import type { LiveRedisResult } from '../types/live.js';
import type { CrossModeResult } from '../types/cross-mode.js';
import type { Recommendation, RecommendationsResult } from '../types/recommendations.js';

// ---------------------------------------------------------------------------
// Module-scope lookup tables (static, never change per call)
// ---------------------------------------------------------------------------

interface RuleMeta {
  effort: Recommendation['effort'];
  why: string;
  fix: string;
}

const RULE_META: Record<FindingRule, RuleMeta> = {
  'missing-ttl': {
    effort: 'low',
    why: 'Keys without a TTL grow unbounded and will consume all available memory over time.',
    fix: "Use the EX option: await redis.set(key, value, 'EX', 300)",
  },
  'setnx-no-expiry': {
    effort: 'low',
    why: 'SETNX without an expiry leaves the key in Redis forever if the follow-up EXPIRE call is missed or the process crashes.',
    fix: "Use the atomic NX+EX form: await redis.set(key, value, 'NX', 'EX', 300)",
  },
  'zero-ttl': {
    effort: 'low',
    why: 'A TTL of 0 is treated as no expiry by Redis, making the key permanent.',
    fix: 'Replace the 0 TTL with a positive value representing your intended cache duration.',
  },
  'negative-ttl': {
    effort: 'low',
    why: 'A negative TTL causes Redis to return an error or expire the key immediately, depending on the command.',
    fix: 'Validate the TTL value before passing it to Redis and ensure it is always a positive integer.',
  },
  'queue-missing-attempts': {
    effort: 'low',
    why: 'Without a retry limit, failed jobs are discarded permanently on the first failure with no recovery.',
    fix: "Add to defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } }",
  },
  'queue-no-remove-on-complete': {
    effort: 'low',
    why: 'Completed jobs accumulate in Redis indefinitely, consuming memory and slowing queue operations.',
    fix: 'Add to defaultJobOptions: { removeOnComplete: { count: 100 } }',
  },
  'queue-no-remove-on-fail': {
    effort: 'low',
    why: 'Failed jobs accumulate in Redis indefinitely. Without a cap, the failed set grows unbounded.',
    fix: 'Add to defaultJobOptions: { removeOnFail: { count: 50 } }',
  },
  'queue-missing-timeout': {
    effort: 'low',
    why: 'Jobs without a timeout can hang forever, blocking workers and causing the queue to stall.',
    fix: 'Add to defaultJobOptions: { timeout: 30000 } (adjust to your expected max job duration)',
  },
  'queue-default-concurrency': {
    effort: 'low',
    why: 'Default concurrency of 1 underutilises available workers and reduces throughput.',
    fix: "Pass an explicit concurrency to your Worker: new Worker('queue', processor, { concurrency: 5 })",
  },
  'queue-missing-stalled-interval': {
    effort: 'medium',
    why: 'Without a stalled interval check, jobs that crash mid-execution are never re-queued and are silently lost.',
    fix: "Add a QueueScheduler: new QueueScheduler('queue', { connection, stalledInterval: 30_000 }). Note: Bull users set the stalledInterval option on the Queue constructor instead.",
  },
};

const RULE_BASE_TITLES: Record<FindingRule, string> = {
  'missing-ttl':                    'Add TTL to SET calls',
  'setnx-no-expiry':                'Add expiry to SETNX calls',
  'zero-ttl':                       'Fix zero TTL values',
  'negative-ttl':                   'Fix negative TTL values',
  'queue-missing-attempts':         'Set retry attempts on queue jobs',
  'queue-no-remove-on-complete':    'Enable removeOnComplete on queues',
  'queue-no-remove-on-fail':        'Enable removeOnFail on queues',
  'queue-missing-timeout':          'Set job timeout on queues',
  'queue-default-concurrency':      'Set explicit worker concurrency',
  'queue-missing-stalled-interval': 'Add stalled job detection',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getConfirmedRules(crossModeResult: CrossModeResult | null): Set<FindingRule> {
  const set = new Set<FindingRule>();
  if (crossModeResult === null) return set;
  for (const insight of crossModeResult.insights) {
    if (insight.kind === 'confirms-finding' && insight.relatedRule !== undefined) {
      set.add(insight.relatedRule);
    }
  }
  return set;
}

function getContradictedRules(crossModeResult: CrossModeResult | null): Set<FindingRule> {
  const set = new Set<FindingRule>();
  if (crossModeResult === null) return set;
  for (const insight of crossModeResult.insights) {
    if (insight.kind === 'contradicts-finding' && insight.relatedRule !== undefined) {
      set.add(insight.relatedRule);
    }
  }
  return set;
}

function severityToPriority(severity: FindingSeverity): 1 | 2 | 3 {
  if (severity === 'error') return 1;
  if (severity === 'warn') return 2;
  return 3;
}

function worstSeverity(severities: FindingSeverity[]): FindingSeverity {
  if (severities.includes('error')) return 'error';
  if (severities.includes('warn')) return 'warn';
  return 'info';
}

// ---------------------------------------------------------------------------
// Step 1: Collapse static findings by rule
// ---------------------------------------------------------------------------

function buildFromStaticFindings(
  cacheResult: CacheAnalysisResult | null,
  queueResult: QueueAnalysisResult | null,
  confirmedRules: Set<FindingRule>,
  contradictedRules: Set<FindingRule>,
): Recommendation[] {
  const allFindings = [
    ...(cacheResult?.findings ?? []),
    ...(queueResult?.findings ?? []),
  ];

  if (allFindings.length === 0) return [];

  // Track unique files per rule (clean Map — no casts)
  const filesByRule = new Map<FindingRule, Set<string>>();
  // Track severities per rule for worst-severity computation
  const severitiesByRule = new Map<FindingRule, FindingSeverity[]>();

  for (const f of allFindings) {
    const files = filesByRule.get(f.rule);
    if (files !== undefined) {
      files.add(f.file);
    } else {
      filesByRule.set(f.rule, new Set([f.file]));
    }

    const sevs = severitiesByRule.get(f.rule);
    if (sevs !== undefined) {
      sevs.push(f.severity);
    } else {
      severitiesByRule.set(f.rule, [f.severity]);
    }
  }

  const recs: Recommendation[] = [];

  for (const [rule, severities] of severitiesByRule) {
    const meta = RULE_META[rule];
    const uniqueFiles = filesByRule.get(rule)?.size ?? 1;
    const fileLabel = uniqueFiles === 1 ? '1 file' : `${uniqueFiles} files`;

    const severity = worstSeverity(severities);
    const confirmedByLive = confirmedRules.has(rule);
    const contradicted = contradictedRules.has(rule);

    let priority: 1 | 2 | 3;
    if (contradicted) {
      priority = 3;
    } else if (severity === 'error') {
      priority = 1;
    } else if (severity === 'warn' && confirmedByLive) {
      priority = 1;
    } else {
      priority = severityToPriority(severity);
    }

    const baseTitle = RULE_BASE_TITLES[rule];
    const title = uniqueFiles > 1
      ? `${baseTitle} (${fileLabel} affected)`
      : baseTitle;

    recs.push({
      priority,
      title,
      why: meta.why,
      fix: meta.fix,
      effort: meta.effort,
      relatedRule: rule,
      confirmedByLive,
    });
  }

  return recs;
}

// ---------------------------------------------------------------------------
// Step 2: Live-only advisories (no static rule)
// ---------------------------------------------------------------------------

function buildFromLiveAdvisories(liveResult: LiveRedisResult): Recommendation[] {
  const recs: Recommendation[] = [];

  if (liveResult.memory.maxBytes === 0) {
    recs.push({
      priority: 2,
      title: 'Set a maxmemory limit on Redis',
      why: 'Without a memory limit Redis will consume all available RAM, potentially crashing the host process.',
      fix: "Set maxmemory in redis.conf: maxmemory 512mb (adjust to your server's available RAM)",
      effort: 'low',
      confirmedByLive: true,
    });
  }

  if (
    liveResult.memory.evictionPolicy === 'noeviction' &&
    liveResult.memory.maxBytes > 0
  ) {
    recs.push({
      priority: 2,
      title: 'Change eviction policy from noeviction',
      why: 'noeviction causes Redis to return errors to clients once maxmemory is reached instead of evicting old keys.',
      fix: 'Set in redis.conf: maxmemory-policy allkeys-lru (or volatile-lru if only some keys have TTLs)',
      effort: 'low',
      confirmedByLive: true,
    });
  }

  if (liveResult.memory.usagePercent >= 80) {
    recs.push({
      priority: 1,
      title: 'Reduce Redis memory usage — approaching limit',
      why: `Memory is at ${liveResult.memory.usagePercent.toFixed(1)}% of the configured limit. At 100% Redis will begin evicting keys or rejecting writes depending on eviction policy.`,
      fix: 'Audit key sizes and TTLs, remove stale data, increase maxmemory, or add more nodes.',
      effort: 'high',
      confirmedByLive: true,
    });
  }

  if (liveResult.memory.fragmentationRatio >= 1.5) {
    recs.push({
      priority: 2,
      title: 'Address high memory fragmentation',
      why: `Fragmentation ratio is ${liveResult.memory.fragmentationRatio.toFixed(2)} (expected < 1.5). Redis is holding more OS memory than it is using, wasting capacity.`,
      fix: 'Enable active defragmentation: CONFIG SET activedefrag yes (Redis 4+), or schedule a Redis restart during low traffic.',
      effort: 'medium',
      confirmedByLive: true,
    });
  }

  return recs;
}

// ---------------------------------------------------------------------------
// Step 3: Sort
// ---------------------------------------------------------------------------

function sortRecommendations(recs: Recommendation[]): Recommendation[] {
  return [...recs].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    // Within same priority: confirmed by live first
    if (a.confirmedByLive !== b.confirmedByLive) return a.confirmedByLive ? -1 : 1;
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildRecommendations(
  cacheResult: CacheAnalysisResult | null,
  queueResult: QueueAnalysisResult | null,
  liveResult: LiveRedisResult | null,
  crossModeResult: CrossModeResult | null,
): RecommendationsResult {
  const confirmedRules = getConfirmedRules(crossModeResult);
  const contradictedRules = getContradictedRules(crossModeResult);

  const staticRecs = buildFromStaticFindings(
    cacheResult,
    queueResult,
    confirmedRules,
    contradictedRules,
  );

  const liveRecs = liveResult !== null
    ? buildFromLiveAdvisories(liveResult)
    : [];

  const all = sortRecommendations([...staticRecs, ...liveRecs]);

  const quickWins = all
    .filter((r) => r.priority === 1 && r.effort === 'low')
    .slice(0, 5);

  const priority1Count = all.filter((r) => r.priority === 1).length;
  const priority2Count = all.filter((r) => r.priority === 2).length;
  const priority3Count = all.filter((r) => r.priority === 3).length;

  return {
    recommendations: all,
    quickWins,
    totalCount: all.length,
    priority1Count,
    priority2Count,
    priority3Count,
  };
}
