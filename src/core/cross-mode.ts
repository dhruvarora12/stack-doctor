import type { CacheAnalysisResult, QueueAnalysisResult } from '../types/findings.js';
import type { LiveRedisResult } from '../types/live.js';
import type { DetectionResult } from '../types/index.js';
import type { CrossModeInsight, CrossModeResult } from '../types/cross-mode.js';
import { QUEUE_COMPLETED_WARN_THRESHOLD } from '../constants.js';

// ---------------------------------------------------------------------------
// Check A: missing-ttl findings + live no-TTL key percentage >= 30%
// ---------------------------------------------------------------------------

function checkMissingTtl(
  cacheResult: CacheAnalysisResult,
  liveResult: LiveRedisResult,
  insights: CrossModeInsight[],
): void {
  const hasMissingTtlFindings = cacheResult.findings.some(
    (f) => f.rule === 'missing-ttl',
  );
  const noTtlPercent = liveResult.keyScan?.noTtlPercent ?? 0;

  if (hasMissingTtlFindings && noTtlPercent >= 30) {
    insights.push({
      kind: 'confirms-finding',
      title: 'Missing TTL confirmed in live data',
      detail: `Static analysis flagged missing TTL calls, and ${noTtlPercent.toFixed(1)}% of live keys have no expiry set.`,
      relatedRule: 'missing-ttl',
      severity: 'warn',
    });
  }
}

// ---------------------------------------------------------------------------
// Check B: no-remove-on-complete findings + live completed count high
// ---------------------------------------------------------------------------

function checkRemoveOnComplete(
  queueResult: QueueAnalysisResult,
  liveResult: LiveRedisResult,
  insights: CrossModeInsight[],
): void {
  if (!liveResult.queueScan) return;

  const hasNoRemoveOnComplete = queueResult.findings.some(
    (f) => f.rule === 'queue-no-remove-on-complete',
  );
  if (!hasNoRemoveOnComplete) return;

  const highCompletedQueues = liveResult.queueScan.queues.filter(
    (q) => q.completed > QUEUE_COMPLETED_WARN_THRESHOLD,
  );
  if (highCompletedQueues.length === 0) return;

  const names = highCompletedQueues.map((q) => `"${q.name}"`).join(', ');
  const total = highCompletedQueues.reduce((s, q) => s + q.completed, 0);

  insights.push({
    kind: 'confirms-finding',
    title: 'removeOnComplete missing — completed jobs accumulating',
    detail: `${total.toLocaleString()} completed jobs are piling up across ${names}. Set removeOnComplete to avoid unbounded growth.`,
    relatedRule: 'queue-no-remove-on-complete',
    severity: 'warn',
  });
}

// ---------------------------------------------------------------------------
// Check C: no-remove-on-fail findings + live failed count > 0
// ---------------------------------------------------------------------------

function checkRemoveOnFail(
  queueResult: QueueAnalysisResult,
  liveResult: LiveRedisResult,
  insights: CrossModeInsight[],
): void {
  if (!liveResult.queueScan) return;

  const hasNoRemoveOnFail = queueResult.findings.some(
    (f) => f.rule === 'queue-no-remove-on-fail',
  );
  if (!hasNoRemoveOnFail) return;

  const failedQueues = liveResult.queueScan.queues.filter((q) => q.failed > 0);
  if (failedQueues.length === 0) return;

  const names = failedQueues.map((q) => `"${q.name}"`).join(', ');
  const total = failedQueues.reduce((s, q) => s + q.failed, 0);

  insights.push({
    kind: 'confirms-finding',
    title: 'removeOnFail missing — failed jobs accumulating',
    detail: `${total.toLocaleString()} failed jobs are accumulating across ${names}. Set removeOnFail to cap retention.`,
    relatedRule: 'queue-no-remove-on-fail',
    severity: 'warn',
  });
}

// ---------------------------------------------------------------------------
// Check D: Redis libs detected statically → live shows 0 keys
// ---------------------------------------------------------------------------

function checkRedisUnused(
  detection: DetectionResult,
  liveResult: LiveRedisResult,
  insights: CrossModeInsight[],
): void {
  if (!detection.hasRedis) return;
  if (liveResult.keyspace.totalKeys > 0) return;

  insights.push({
    kind: 'new-finding',
    title: 'Redis libraries detected but no keys found in live instance',
    detail:
      'Static analysis found Redis client usage, but the connected instance is empty. Redis may be misconfigured, pointing at the wrong instance, or not yet in use.',
    severity: 'info',
  });
}

// ---------------------------------------------------------------------------
// Check E: No Redis libs detected → live shows keys exist
// ---------------------------------------------------------------------------

function checkRedisUndetected(
  detection: DetectionResult,
  liveResult: LiveRedisResult,
  insights: CrossModeInsight[],
): void {
  if (detection.hasRedis) return;
  if (liveResult.keyspace.totalKeys === 0) return;

  insights.push({
    kind: 'new-finding',
    title: 'Redis keys found but no Redis library detected statically',
    detail: `Live instance has ${liveResult.keyspace.totalKeys.toLocaleString()} keys, but no known Redis client was found in the codebase. Redis may be used via a wrapper library or indirect dependency not visible to static analysis.`,
    severity: 'warn',
  });
}

// ---------------------------------------------------------------------------
// Check F: missing-attempts findings + live total failed > 0
// ---------------------------------------------------------------------------

function checkMissingAttempts(
  queueResult: QueueAnalysisResult,
  liveResult: LiveRedisResult,
  insights: CrossModeInsight[],
): void {
  if (!liveResult.queueScan) return;

  const hasMissingAttempts = queueResult.findings.some(
    (f) => f.rule === 'queue-missing-attempts',
  );
  if (!hasMissingAttempts) return;
  if (liveResult.queueScan.totalFailed === 0) return;

  insights.push({
    kind: 'confirms-finding',
    title: 'Missing retry config — jobs are actually failing',
    detail: `Static analysis found missing attempts/retry configuration, and ${liveResult.queueScan.totalFailed.toLocaleString()} failed jobs are present in the live instance. Jobs that fail without retries are lost permanently.`,
    relatedRule: 'queue-missing-attempts',
    severity: 'warn',
  });
}

// ---------------------------------------------------------------------------
// Check G: all-clear — zero static findings + zero failed/stalled
// ---------------------------------------------------------------------------

function checkAllClear(
  cacheResult: CacheAnalysisResult,
  queueResult: QueueAnalysisResult,
  liveResult: LiveRedisResult,
  insights: CrossModeInsight[],
): void {
  const hasStaticFindings =
    cacheResult.findings.length > 0 || queueResult.findings.length > 0;
  if (hasStaticFindings) return;

  const hasFailed = (liveResult.queueScan?.totalFailed ?? 0) > 0;
  const hasStalled =
    liveResult.queueScan?.queues.some((q) => q.hasStalled) ?? false;
  if (hasFailed || hasStalled) return;

  insights.push({
    kind: 'all-clear',
    title: 'All checks passed',
    detail:
      'No static cache or queue findings, and no failed or stalled jobs in the live instance.',
    severity: 'info',
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function analyzeCrossModes(
  cacheResult: CacheAnalysisResult,
  queueResult: QueueAnalysisResult,
  liveResult: LiveRedisResult,
  detection: DetectionResult,
): CrossModeResult {
  const insights: CrossModeInsight[] = [];

  checkMissingTtl(cacheResult, liveResult, insights);
  checkRemoveOnComplete(queueResult, liveResult, insights);
  checkRemoveOnFail(queueResult, liveResult, insights);
  checkRedisUnused(detection, liveResult, insights);
  checkRedisUndetected(detection, liveResult, insights);
  checkMissingAttempts(queueResult, liveResult, insights);
  checkAllClear(cacheResult, queueResult, liveResult, insights);

  const confirmedCount = insights.filter(
    (i) => i.kind === 'confirms-finding',
  ).length;
  const contradictedCount = insights.filter(
    (i) => i.kind === 'contradicts-finding',
  ).length;
  const newFindingCount = insights.filter(
    (i) => i.kind === 'new-finding',
  ).length;

  return { insights, confirmedCount, contradictedCount, newFindingCount };
}
