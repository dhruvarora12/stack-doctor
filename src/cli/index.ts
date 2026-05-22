import { Command, Option } from 'commander';
import { writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { detectProject } from '../core/detect.js';
import { scanFiles } from '../core/scanner.js';
import { analyzeCache } from '../core/analyze-cache.js';
import { analyzeQueue } from '../core/analyze-queue.js';
import { analyzeLive } from '../core/live-redis.js';
import type { CliOptions, DetectionResult } from '../types/index.js';
import type { CacheAnalysisResult, Finding, FindingSeverity, QueueAnalysisResult } from '../types/findings.js';
import type { ScanResult } from '../types/scan.js';
import type { KeyScanResult, LiveRedisResult, QueueScanResult } from '../types/live.js';
import { analyzeCrossModes } from '../core/cross-mode.js';
import type { CrossModeResult } from '../types/cross-mode.js';

const program = new Command();

program
  .name('stack-doctor')
  .description('Static + live analysis of Redis caching and queuing in Node.js backends.')
  .version('0.1.0')
  .argument('[path]', 'Target project directory', process.cwd())
  .addOption(
    new Option(
      '-o, --output <format>',
      'Output format (default: saves stack-doctor-report-YYYY-MM-DD.md in target directory)',
    )
      .choices(['text', 'json', 'markdown'])
    // no .default() — absence means auto-save mode
  )
  .option('-v, --verbose', 'Enable verbose logging', false)
  .option('--no-color', 'Disable colored output')
  .option('--skip-cache', 'Skip cache analysis', false)
  .option('--skip-queues', 'Skip queue analysis', false)
  .option('--live', 'Run live Redis inspection', false)
  .option('--redis-url <url>', 'Redis connection URL (requires --live)')
  .option('-y, --yes', 'Skip safety countdown for CI use', false)
  .option('--env-file <path>', 'Read Redis URL from .env file (requires --live)', '.env')
  .option('--sample-size <n>', 'Keys to sample in live mode (default: 1000)', '1000')
  .option('--idle-threshold <days>', 'Days before a key is considered idle (default: 30)', '30')
  .action(async (targetPath: string, rawOpts: Record<string, unknown>) => {
    // --skip-cache + --skip-queues is only an error when --live is not set
    if (rawOpts['skipCache'] === true && rawOpts['skipQueues'] === true && rawOpts['live'] !== true) {
      console.error('Error: --skip-cache and --skip-queues together leave nothing to analyze.');
      process.exit(1);
    }

    if (rawOpts['redisUrl'] !== undefined && rawOpts['live'] !== true) {
      console.error('Error: --redis-url requires --live.');
      process.exit(1);
    }

    if (rawOpts['live'] === true && rawOpts['redisUrl'] === undefined) {
      console.error('Error: --live requires --redis-url <url>.');
      process.exit(1);
    }

    const isAutoMode = rawOpts['output'] === undefined;
    const date = new Date().toISOString().split('T')[0]!;

    const options: CliOptions = {
      output: (rawOpts['output'] as 'text' | 'json' | 'markdown') ?? 'text',
      verbose: rawOpts['verbose'] as boolean,
      color: rawOpts['color'] as boolean,
      skipCache: rawOpts['skipCache'] as boolean,
      skipQueues: rawOpts['skipQueues'] as boolean,
      live: rawOpts['live'] as boolean,
      redisUrl: rawOpts['redisUrl'] as string | undefined,
      envFile: rawOpts['envFile'] as string,
      sampleSize: parseInt(rawOpts['sampleSize'] as string, 10),
      idleThreshold: parseInt(rawOpts['idleThreshold'] as string, 10),
    };

    if (options.verbose) {
      console.log(`Scanning: ${targetPath}`);
    }

    const result = await detectProject(targetPath);

    if (!result.isNodeProject) {
      console.log('No package.json found. Is this a Node.js project?');
      process.exit(0);
    }

    // Allow --live to proceed even when no static Redis usage is found
    if (!result.hasRedis && !result.hasQueues && !options.live) {
      console.log(
        'No Redis usage found in code. Use --live --redis-url <url> to inspect a Redis instance directly.',
      );
      process.exit(0);
    }

    // Static analysis (libNames may be empty if all filtered or no clients found)
    const libNames = result.clients
      .filter(c => {
        if (options.skipCache && c.category === 'redis-client') return false;
        if (options.skipQueues && c.category === 'redis-queue') return false;
        return true;
      })
      .map(c => c.name);

    const scanResult = await scanFiles(targetPath, libNames);
    const cacheResult = options.skipCache ? null : analyzeCache(scanResult);
    const queueResult = options.skipQueues ? null : analyzeQueue(scanResult);
    const summary = buildReportSummary(cacheResult, queueResult);

    // Live analysis — runs after static, outputs together
    let liveResult: LiveRedisResult | null = null;
    if (options.live) {
      const skipCountdown = rawOpts['yes'] as boolean;
      await runCountdown(options.redisUrl!, skipCountdown);

      // Show progress counter only when output won't be corrupted by \r writes
      const showProgress = options.output !== 'json' && options.output !== 'markdown';

      try {
        liveResult = await analyzeLive(options.redisUrl!, {
          sampleSize: options.sampleSize,
          idleThresholdDays: options.idleThreshold,
          skipQueues: options.skipQueues,
          onProgress: showProgress
            ? (scanned, total) => {
                process.stdout.write(`\rScanning keys... ${scanned}/${total}`);
              }
            : undefined,
        });
      } catch (err) {
        console.error(`\nError: Could not connect to Redis at ${options.redisUrl!}`);
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      // Clear progress line after scan completes
      if (showProgress) {
        process.stdout.write('\r' + ' '.repeat(40) + '\r');
      }
    }

    const crossModeResult: CrossModeResult | null =
      liveResult !== null
        ? analyzeCrossModes(
            cacheResult ?? { findings: [], filesAnalyzed: 0, disclaimer: '' },
            queueResult ?? { findings: [], filesAnalyzed: 0, disclaimer: '', advisories: [] },
            liveResult,
            result,
          )
        : null;

    if (isAutoMode) {
      const filename = `stack-doctor-report-${date}.md`;
      const filepath = join(resolve(targetPath), filename);
      const md = buildMarkdownReport(result, scanResult, cacheResult, queueResult, liveResult, crossModeResult, summary, options, date);
      await writeFile(filepath, md, 'utf-8');
      const rel = './' + relative(process.cwd(), filepath).replace(/\\/g, '/');
      console.log(`Report saved to ${rel}`);
      return;
    }

    printReport(result, scanResult, cacheResult, queueResult, liveResult, crossModeResult, summary, options, date);
  });

program.parse();

// ── Countdown helpers ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}

async function runCountdown(url: string, skipCountdown: boolean): Promise<void> {
  process.stderr.write(`\nConnecting to ${url} (read-only inspection).\n`);
  process.stderr.write('This tool will not modify any data. Press Ctrl+C to cancel.\n');
  if (skipCountdown) {
    process.stderr.write('Proceeding...\n\n');
    return;
  }
  process.stderr.write('Proceeding in 3 seconds...\n');
  for (let i = 3; i >= 1; i--) {
    process.stderr.write(`\r${i}...`);
    await sleep(1000);
  }
  process.stderr.write('\r      \n\n');
}

// ── Internal report model ─────────────────────────────────────────────────────

type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

interface FileGroup {
  path: string;
  findings: Finding[];
  worstSeverity: FindingSeverity;
}

interface ReportSummary {
  errors: number;
  warnings: number;
  filesAffected: number;
  totalFindings: number;
}

// ── Grade ─────────────────────────────────────────────────────────────────────

function computeGrade(errors: number, warnings: number): Grade {
  if (errors >= 6) return 'F';
  if (errors >= 3) return 'D';
  if (errors >= 1) return 'C';   // 1–2 errors
  if (warnings >= 4) return 'C'; // 0 errors, 4+ warnings
  if (warnings >= 1) return 'B';
  return 'A';
}

// ── File groups ───────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 0, warn: 1, info: 2 };

/**
 * Groups findings by file path, sorts within each group (errors → warnings → info,
 * stable), then sorts the groups themselves (error-files first, then warn, then info).
 * Returns [] when findings is empty — safe to call when both results are null.
 */
function buildFileGroups(findings: Finding[]): FileGroup[] {
  if (findings.length === 0) return [];

  const map = new Map<string, Finding[]>();
  for (const f of findings) {
    const existing = map.get(f.file);
    if (existing !== undefined) {
      existing.push(f);
    } else {
      map.set(f.file, [f]);
    }
  }

  const groups: FileGroup[] = [];
  for (const [path, group] of map) {
    const sorted = [...group].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    groups.push({ path, findings: sorted, worstSeverity: sorted[0]!.severity });
  }

  groups.sort((a, b) => SEVERITY_RANK[a.worstSeverity] - SEVERITY_RANK[b.worstSeverity]);
  return groups;
}

// ── Summary ───────────────────────────────────────────────────────────────────

function buildReportSummary(
  cacheResult: CacheAnalysisResult | null,
  queueResult: QueueAnalysisResult | null,
): ReportSummary {
  const allFindings: Finding[] = [
    ...(cacheResult?.findings ?? []),
    ...(queueResult?.findings ?? []),
  ];
  const errors = allFindings.filter(f => f.severity === 'error').length;
  const warnings = allFindings.filter(f => f.severity === 'warn').length;
  const filesAffected = new Set(allFindings.map(f => f.file)).size;
  return { errors, warnings, filesAffected, totalFindings: allFindings.length };
}

function formatGradeLine(summary: ReportSummary): string {
  const grade = computeGrade(summary.errors, summary.warnings);
  const parts: string[] = [];
  if (summary.errors > 0) parts.push(`${summary.errors} error${summary.errors > 1 ? 's' : ''}`);
  if (summary.warnings > 0) parts.push(`${summary.warnings} warning${summary.warnings > 1 ? 's' : ''}`);
  if (summary.filesAffected > 0) {
    parts.push(`${summary.filesAffected} ${summary.filesAffected === 1 ? 'file' : 'files'} affected`);
  }
  const detail = parts.length > 0 ? `   ${parts.join(' · ')}` : '';
  return `Grade: ${grade}${detail}`;
}

// ── Live section formatting helpers ──────────────────────────────────────────

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatIdleTime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatTtl(ttl: number): string {
  if (ttl === -1) return 'none';
  if (ttl === -2) return 'expired';
  return `${ttl}s`;
}

function truncateKey(key: string, maxLen = 45): string {
  return key.length <= maxLen ? key : key.slice(0, maxLen - 1) + '…';
}

function buildLiveMemoryLine(live: LiveRedisResult): string {
  return live.memory.maxBytes > 0
    ? `${live.memory.usedHuman} / ${live.memory.maxHuman} (${live.memory.usagePercent.toFixed(1)}%)`
    : `${live.memory.usedHuman} / no limit`;
}

function buildLiveKeyLine(live: LiveRedisResult): string {
  const total = live.keyspace.totalKeys.toLocaleString();
  if (live.keyspace.totalKeys === 0) return `${total} total`;
  const withTtl = live.keyspace.keysWithTtl.toLocaleString();
  const withoutTtl = live.keyspace.keysWithoutTtl.toLocaleString();
  return `${total} total  (${withTtl} with TTL · ${withoutTtl} without)`;
}

// ── Markdown builder (shared by auto-save and --output markdown) ──────────────

function buildMarkdownReport(
  result: DetectionResult,
  scanResult: ScanResult,
  cacheResult: CacheAnalysisResult | null,
  queueResult: QueueAnalysisResult | null,
  liveResult: LiveRedisResult | null,
  crossModeResult: CrossModeResult | null,
  summary: ReportSummary,
  options: CliOptions,
  date: string,
): string {
  const lines: string[] = [];

  const clients = result.clients.filter(c => {
    if (options.skipCache && c.category === 'redis-client') return false;
    if (options.skipQueues && c.category === 'redis-queue') return false;
    return true;
  });

  // ── Header + grade (grade first per Option A) ──
  lines.push('# Stack Doctor Report', '');
  lines.push(`_Generated: ${date}_`, '');
  lines.push(formatGradeLine(summary), '');

  // ── Libraries + scan stats ──
  lines.push('## Detected Libraries', '');
  for (const c of clients) {
    lines.push(`- **${c.name}** \`${c.version}\` — ${c.category}`);
  }

  lines.push('', '## Source Files', '');
  lines.push(formatScanSummary(scanResult));
  if (scanResult.files.length > 0) {
    lines.push('');
    for (const f of scanResult.files) {
      lines.push(`### \`${f.path}\``);
      for (const imp of f.imports) {
        const name = imp.localName !== null ? ` as \`${imp.localName}\`` : '';
        lines.push(`- \`${imp.library}\`${name} (${imp.importStyle}, line ${imp.line})`);
      }
    }
  }

  // ── Static analysis sections ──
  const cacheRan = cacheResult !== null;
  const queueRan = queueResult !== null;
  const cacheHasFindings = cacheRan && cacheResult.findings.length > 0;
  const queueHasFindings = queueRan && queueResult.findings.length > 0;
  const bothRanAndClean = cacheRan && queueRan && !cacheHasFindings && !queueHasFindings;

  if (bothRanAndClean) {
    lines.push('', '## Analysis', '');
    lines.push('✓ No static issues found. Run with `--live` to check your live Redis instance.');
  } else {
    // Cache section
    if (options.skipCache) {
      lines.push('', '_Cache analysis skipped (`--skip-cache`). Run without this flag to include it._');
    } else if (cacheRan && !cacheHasFindings) {
      lines.push('', '_Cache: no issues found ✓_');
    } else if (cacheResult !== null) {
      lines.push('', '## Cache Analysis', '');
      lines.push(formatFindingsSummary(cacheResult.findings, cacheResult.filesAnalyzed), '');
      for (const group of buildFileGroups(cacheResult.findings)) {
        lines.push(`### \`${group.path}\``, '');
        for (const f of group.findings) lines.push(...formatFindingMarkdown(f));
      }
      lines.push(`> ${cacheResult.disclaimer}`);
    }

    // Queue section
    if (options.skipQueues) {
      lines.push('', '_Queue analysis skipped (`--skip-queues`). Run without this flag to include it._');
    } else if (queueRan && !queueHasFindings) {
      lines.push('', '_Queue: no issues found ✓_');
      if (queueResult!.advisories.length > 0) {
        lines.push('');
        for (const a of queueResult!.advisories) lines.push(`> ${a}`, '');
      }
    } else if (queueResult !== null) {
      lines.push('', '## Queue Analysis', '');
      if (queueResult.advisories.length > 0) {
        for (const a of queueResult.advisories) lines.push(`> ${a}`, '');
      }
      lines.push(formatFindingsSummary(queueResult.findings, queueResult.filesAnalyzed), '');
      for (const group of buildFileGroups(queueResult.findings)) {
        lines.push(`### \`${group.path}\``, '');
        for (const f of group.findings) lines.push(...formatFindingMarkdown(f));
      }
      lines.push(`> ${queueResult.disclaimer}`);
    }
  }

  // ── Insights (cross-mode, only when live ran) ──
  if (liveResult !== null) {
    lines.push(...buildInsightsMarkdownLines(crossModeResult));
  }

  // ── Live section (after static, per Bucket 6a) ──
  if (liveResult !== null) {
    lines.push(...buildLiveMarkdownLines(liveResult, options.idleThreshold));
  }

  // ── Warnings + skipped files ──
  if (result.warnings.length > 0) {
    lines.push('', '## Warnings', '');
    for (const w of result.warnings) lines.push(`- ${w}`);
  }

  const k = scanResult.skipped.length;
  if (k > 0) {
    lines.push('', '## Skipped Files', '');
    lines.push(`${k} ${k === 1 ? 'file was' : 'files were'} skipped during scanning.`, '');
    for (const s of scanResult.skipped) {
      const loc = s.line !== undefined ? `:${s.line}` : '';
      lines.push(`- \`${s.path}${loc}\` — ${s.reason}: ${s.message}`);
    }
  }

  return lines.join('\n');
}

function buildLiveMarkdownLines(live: LiveRedisResult, idleThresholdDays: number): string[] {
  const lines: string[] = [];
  const hitInfo =
    live.cacheHitRate !== null
      ? `${live.cacheHitRate.toFixed(1)}%`
      : 'n/a (no requests yet)';

  lines.push('', '## Live Redis Health', '');
  lines.push(
    `_Redis ${live.redisVersion}  ·  uptime ${formatUptime(live.uptimeSeconds)}  ·  ${live.connectedClients} connected ${live.connectedClients === 1 ? 'client' : 'clients'}_`,
    '',
  );
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Memory | ${buildLiveMemoryLine(live)} |`);
  lines.push(`| Keys | ${buildLiveKeyLine(live)} |`);
  lines.push(`| Hit rate | ${hitInfo} |`);
  lines.push(`| Eviction | ${live.memory.evictionPolicy} |`);
  lines.push(`| Frag. ratio | ${live.memory.fragmentationRatio.toFixed(2)} |`);

  if (live.warnings.length > 0) {
    lines.push('');
    for (const w of live.warnings) lines.push(`> ! ${w}`);
  }

  lines.push(...buildQueueScanMarkdownLines(live.queueScan));
  lines.push(...buildKeyScanMarkdownLines(live.keyScan, idleThresholdDays));

  return lines;
}

function buildKeyScanMarkdownLines(
  ks: KeyScanResult | null,
  idleThresholdDays: number,
): string[] {
  const lines: string[] = [];

  if (ks === null) {
    lines.push('', '### Key Analysis', '');
    lines.push('No keys found in keyspace — nothing to scan.');
    return lines;
  }

  lines.push('', `### Key Analysis _(${ks.scanned.toLocaleString()} keys sampled)_`, '');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Keys with no TTL | ${ks.noTtlCount.toLocaleString()} of ${ks.scanned.toLocaleString()} (${ks.noTtlPercent.toFixed(1)}%) |`);
  lines.push(`| Idle keys | ${ks.idleKeys.length} (idle > ${idleThresholdDays}d) |`);
  lines.push(`| Oversized keys | ${ks.oversizedKeys.length} (> 512 KB) |`);

  if (ks.idleKeys.length > 0) {
    lines.push('', '**Top idle keys**', '');
    lines.push('| Key | Idle | TTL | Memory |');
    lines.push('|-----|------|-----|--------|');
    for (const k of ks.idleKeys) {
      lines.push(`| \`${k.key}\` | ${formatIdleTime(k.idleSeconds)} | ${formatTtl(k.ttl)} | ${formatBytes(k.memoryBytes)} |`);
    }
  }

  if (ks.oversizedKeys.length > 0) {
    lines.push('', '**Top oversized keys**', '');
    lines.push('| Key | Memory | TTL | Idle |');
    lines.push('|-----|--------|-----|------|');
    for (const k of ks.oversizedKeys) {
      lines.push(`| \`${k.key}\` | ${formatBytes(k.memoryBytes)} | ${formatTtl(k.ttl)} | ${formatIdleTime(k.idleSeconds)} |`);
    }
  }

  const hasNamespaces = ks.namespaces.some(n => n.prefix !== '(no prefix)');
  if (hasNamespaces) {
    lines.push('', '**Namespace breakdown**', '');
    lines.push('| Prefix | Keys | Memory | % of total |');
    lines.push('|--------|------|--------|------------|');
    for (const ns of ks.namespaces) {
      lines.push(`| \`${ns.prefix}\` | ${ns.keyCount.toLocaleString()} | ${formatBytes(ns.memoryBytes)} | ${ns.memoryPercent.toFixed(1)}% |`);
    }
  } else {
    lines.push('', 'No namespace patterns detected.');
  }

  if (ks.warnings.length > 0) {
    lines.push('');
    for (const w of ks.warnings) lines.push(`> ! ${w}`);
  }

  return lines;
}

// ── Text / JSON / explicit markdown output ────────────────────────────────────

function printReport(
  result: DetectionResult,
  scanResult: ScanResult,
  cacheResult: CacheAnalysisResult | null,
  queueResult: QueueAnalysisResult | null,
  liveResult: LiveRedisResult | null,
  crossModeResult: CrossModeResult | null,
  summary: ReportSummary,
  options: CliOptions,
  date: string,
): void {
  const clients = result.clients.filter(c => {
    if (options.skipCache && c.category === 'redis-client') return false;
    if (options.skipQueues && c.category === 'redis-queue') return false;
    return true;
  });

  if (options.output === 'json') {
    console.log(
      JSON.stringify(
        {
          summary: {
            errors: summary.errors,
            warnings: summary.warnings,
            filesAffected: summary.filesAffected,
            totalFindings: summary.totalFindings,
          },
          clients,
          warnings: result.warnings,
          scanStats: scanResult.stats,
          filesWithImports: scanResult.files.map(f => ({ path: f.path, imports: f.imports })),
          skippedFiles: scanResult.skipped,
          ...(cacheResult !== null
            ? {
                cacheAnalysis: {
                  findings: cacheResult.findings,
                  filesAnalyzed: cacheResult.filesAnalyzed,
                  disclaimer: cacheResult.disclaimer,
                },
              }
            : {}),
          ...(queueResult !== null
            ? {
                queueAnalysis: {
                  findings: queueResult.findings,
                  filesAnalyzed: queueResult.filesAnalyzed,
                  disclaimer: queueResult.disclaimer,
                  advisories: queueResult.advisories,
                },
              }
            : {}),
          ...(liveResult !== null
            ? {
                liveAnalysis: {
                  host: liveResult.host,
                  redisVersion: liveResult.redisVersion,
                  uptimeSeconds: liveResult.uptimeSeconds,
                  connectedClients: liveResult.connectedClients,
                  memory: liveResult.memory,
                  keyspace: liveResult.keyspace,
                  cacheHitRate: liveResult.cacheHitRate,
                  warnings: liveResult.warnings,
                  queueScan: liveResult.queueScan,
                  keyScan: liveResult.keyScan,
                },
              }
            : {}),
          ...(crossModeResult !== null
            ? { crossModeAnalysis: crossModeResult }
            : {}),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (options.output === 'markdown') {
    console.log(buildMarkdownReport(result, scanResult, cacheResult, queueResult, liveResult, crossModeResult, summary, options, date));
    return;
  }

  // ── Text ──────────────────────────────────────────────────────────────────
  console.log('\nStack Doctor — Static Analysis\n');
  console.log(formatGradeLine(summary));
  console.log(`\nScanned: ${result.packageJsonPath ?? 'unknown'}\n`);

  if (clients.length === 0) {
    console.log('No matching libraries found with current --skip-* filters.');
    if (liveResult !== null) printLiveSection(liveResult, options.idleThreshold);
    return;
  }

  console.log('Detected libraries:');
  for (const c of clients) {
    const tag = c.category === 'redis-client' ? '[cache]' : '[queue]';
    const loc = c.isDirect ? 'dependencies' : 'devDependencies';
    console.log(`  ${tag} ${c.name} ${c.version}  (${loc})`);
  }

  console.log('');
  console.log(formatScanSummary(scanResult));

  if (scanResult.files.length > 0) {
    console.log('');
    for (const f of scanResult.files) {
      console.log(`  ${f.path}`);
      for (const imp of f.imports) {
        const name = imp.localName !== null ? `${imp.importStyle}: ${imp.localName}` : imp.importStyle;
        console.log(`    → ${imp.library}  (${name})  line ${imp.line}`);
      }
    }
  }

  // ── Static analysis sections ──
  const cacheRan = cacheResult !== null;
  const queueRan = queueResult !== null;
  const cacheHasFindings = cacheRan && cacheResult.findings.length > 0;
  const queueHasFindings = queueRan && queueResult.findings.length > 0;
  const bothRanAndClean = cacheRan && queueRan && !cacheHasFindings && !queueHasFindings;

  if (bothRanAndClean) {
    console.log('\n✓ No static issues found. Run with --live to check your live Redis instance.');
  } else {
    // Cache section
    if (options.skipCache) {
      console.log('\nCache analysis skipped (--skip-cache). Run without this flag to include it.');
    } else if (cacheRan && !cacheHasFindings) {
      console.log('\nCache: no issues found ✓');
    } else if (cacheResult !== null) {
      printAnalysisSection('Cache Analysis', cacheResult.findings, cacheResult.filesAnalyzed, cacheResult.disclaimer);
    }

    // Queue section
    if (options.skipQueues) {
      console.log('\nQueue analysis skipped (--skip-queues). Run without this flag to include it.');
    } else if (queueRan && !queueHasFindings) {
      console.log('\nQueue: no issues found ✓');
      if (queueResult!.advisories.length > 0) {
        for (const a of queueResult!.advisories) console.log(`  ! ${a}`);
      }
    } else if (queueResult !== null) {
      printAnalysisSection(
        'Queue Analysis',
        queueResult.findings,
        queueResult.filesAnalyzed,
        queueResult.disclaimer,
        queueResult.advisories,
      );
    }
  }

  // ── Insights (cross-mode, only when live ran) ──
  if (liveResult !== null) {
    printInsightsSection(crossModeResult);
  }

  // ── Live section (after static, per Bucket 6a) ──
  if (liveResult !== null) {
    printLiveSection(liveResult, options.idleThreshold);
  }

  if (result.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of result.warnings) console.log(`  ! ${w}`);
  }

  printSkippedSummary(scanResult, options);
  console.log('');
}

function printLiveSection(live: LiveRedisResult, idleThresholdDays: number): void {
  console.log('\nLive Redis Health\n');
  console.log(
    `  Redis ${live.redisVersion}  ·  uptime ${formatUptime(live.uptimeSeconds)}  ·  ${live.connectedClients} connected ${live.connectedClients === 1 ? 'client' : 'clients'}`,
  );
  console.log('');

  const hitInfo =
    live.cacheHitRate !== null
      ? `${live.cacheHitRate.toFixed(1)}%`
      : 'n/a (no requests yet)';

  const rows: Array<[string, string]> = [
    ['Memory', buildLiveMemoryLine(live)],
    ['Keys', buildLiveKeyLine(live)],
    ['Hit rate', hitInfo],
    ['Eviction', live.memory.evictionPolicy],
    ['Frag. ratio', live.memory.fragmentationRatio.toFixed(2)],
  ];

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(labelWidth)}  ${value}`);
  }

  if (live.warnings.length > 0) {
    console.log('');
    for (const w of live.warnings) console.log(`  ! ${w}`);
  }

  // Queue Scan sub-section (before Key Analysis, per Bucket 5)
  if (live.queueScan !== null) {
    printQueueScanSection(live.queueScan);
  }

  // Key Analysis sub-section
  if (live.keyScan !== null) {
    printKeyScanSection(live.keyScan, idleThresholdDays);
  } else {
    console.log('\n  Key Analysis\n');
    console.log('  No keys found in keyspace — nothing to scan.');
    console.log('');
  }
}

function printKeyScanSection(ks: KeyScanResult, idleThresholdDays: number): void {
  console.log(`\n  Key Analysis  (${ks.scanned.toLocaleString()} keys sampled)\n`);
  console.log(`  No-TTL     ${ks.noTtlCount.toLocaleString()} of ${ks.scanned.toLocaleString()} (${ks.noTtlPercent.toFixed(1)}%)`);
  console.log(`  Idle       ${ks.idleKeys.length} ${ks.idleKeys.length === 1 ? 'key' : 'keys'}  (idle > ${idleThresholdDays}d)`);
  console.log(`  Oversized  ${ks.oversizedKeys.length} ${ks.oversizedKeys.length === 1 ? 'key' : 'keys'}  (> 512 KB)`);

  if (ks.idleKeys.length > 0) {
    console.log('\n  Top idle keys:');
    for (const k of ks.idleKeys) {
      const keyCol = truncateKey(k.key).padEnd(46);
      const idleCol = ('idle ' + formatIdleTime(k.idleSeconds)).padEnd(10);
      const ttlCol  = ('TTL ' + formatTtl(k.ttl)).padEnd(12);
      console.log(`    ${keyCol}  ${idleCol}  ${ttlCol}  ${formatBytes(k.memoryBytes)}`);
    }
  }

  if (ks.oversizedKeys.length > 0) {
    console.log('\n  Top oversized keys:');
    for (const k of ks.oversizedKeys) {
      const keyCol  = truncateKey(k.key).padEnd(46);
      const memCol  = formatBytes(k.memoryBytes).padEnd(10);
      const ttlCol  = ('TTL ' + formatTtl(k.ttl)).padEnd(12);
      console.log(`    ${keyCol}  ${memCol}  ${ttlCol}  idle ${formatIdleTime(k.idleSeconds)}`);
    }
  }

  const hasNamespaces = ks.namespaces.some(n => n.prefix !== '(no prefix)');
  if (hasNamespaces) {
    console.log('\n  Namespace breakdown:');
    const labelW = Math.max(...ks.namespaces.map(n => n.prefix.length), 6);
    console.log(`  ${'Prefix'.padEnd(labelW + 2)}  ${'Keys'.padStart(6)}  ${'Memory'.padStart(10)}  ${'% total'.padStart(7)}`);
    for (const ns of ks.namespaces) {
      console.log(
        `    ${ns.prefix.padEnd(labelW)}  ${ns.keyCount.toLocaleString().padStart(6)}  ${formatBytes(ns.memoryBytes).padStart(10)}  ${ns.memoryPercent.toFixed(1).padStart(6)}%`,
      );
    }
  } else {
    console.log('\n  No namespace patterns detected.');
  }

  if (ks.warnings.length > 0) {
    console.log('');
    for (const w of ks.warnings) console.log(`  ! ${w}`);
  }
  console.log('');
}

function printQueueScanSection(qs: QueueScanResult): void {
  console.log('\n  Queue Scan\n');

  if (qs.queues.length === 0) {
    console.log('  No queues detected in Redis.');
    console.log('');
    return;
  }

  // Column widths
  const nameW = Math.max(...qs.queues.map(q => q.name.length), 4);
  const header =
    `  ${'Name'.padEnd(nameW)}` +
    `  ${'Waiting'.padStart(7)}` +
    `  ${'Active'.padStart(6)}` +
    `  ${'Completed'.padStart(9)}` +
    `  ${'Failed'.padStart(6)}` +
    `  ${'Delayed'.padStart(7)}` +
    `  Stalled`;
  console.log(header);
  console.log('  ' + '─'.repeat(header.length - 2));

  for (const q of qs.queues) {
    console.log(
      `  ${q.name.padEnd(nameW)}` +
      `  ${q.waiting.toLocaleString().padStart(7)}` +
      `  ${q.active.toLocaleString().padStart(6)}` +
      `  ${q.completed.toLocaleString().padStart(9)}` +
      `  ${q.failed.toLocaleString().padStart(6)}` +
      `  ${q.delayed.toLocaleString().padStart(7)}` +
      `  ${q.hasStalled ? 'Yes' : 'No'}`,
    );
  }

  const allWarnings = qs.queues.flatMap(q => q.warnings);
  if (allWarnings.length > 0) {
    console.log('');
    for (const w of allWarnings) console.log(`  ! ${w}`);
  }
  console.log('');
}

function buildQueueScanMarkdownLines(qs: QueueScanResult | null): string[] {
  const lines: string[] = [];

  lines.push('', '### Queue Scan', '');

  if (qs === null) return lines; // --skip-queues: omit section body

  if (qs.queues.length === 0) {
    lines.push('No queues detected in Redis.');
    return lines;
  }

  lines.push('| Name | Waiting | Active | Completed | Failed | Delayed | Stalled |');
  lines.push('|------|---------|--------|-----------|--------|---------|---------|');
  for (const q of qs.queues) {
    lines.push(
      `| ${q.name} | ${q.waiting.toLocaleString()} | ${q.active.toLocaleString()} | ${q.completed.toLocaleString()} | ${q.failed.toLocaleString()} | ${q.delayed.toLocaleString()} | ${q.hasStalled ? 'Yes' : 'No'} |`,
    );
  }

  const allWarnings = qs.queues.flatMap(q => q.warnings);
  if (allWarnings.length > 0) {
    lines.push('');
    for (const w of allWarnings) lines.push(`> ! ${w}`);
  }

  return lines;
}

function printInsightsSection(cm: CrossModeResult | null): void {
  if (cm === null) return;
  console.log('\nInsights\n');
  if (cm.insights.length === 0) {
    console.log('  No cross-mode insights.');
    console.log('');
    return;
  }
  for (const insight of cm.insights) {
    const icon =
      insight.kind === 'all-clear'   ? '✓' :
      insight.kind === 'new-finding' ? '!' : '⚠';
    console.log(`  ${icon} ${insight.title}`);
    console.log(`    ${insight.detail}`);
    console.log('');
  }
}

function buildInsightsMarkdownLines(cm: CrossModeResult | null): string[] {
  if (cm === null) return [];
  const lines: string[] = [];
  lines.push('', '## Insights', '');
  if (cm.insights.length === 0) {
    lines.push('No cross-mode insights.');
    return lines;
  }
  for (const insight of cm.insights) {
    const icon =
      insight.kind === 'all-clear'   ? '✓' :
      insight.kind === 'new-finding' ? '!' : '⚠';
    lines.push(`- ${icon} **${insight.title}** — ${insight.detail}`);
  }
  return lines;
}

function printAnalysisSection(
  title: string,
  findings: Finding[],
  filesAnalyzed: number,
  disclaimer: string,
  advisories?: string[],
): void {
  console.log(`\n${title}`);
  if (advisories !== undefined && advisories.length > 0) {
    for (const a of advisories) console.log(`  ! ${a}`);
  }
  console.log(`\n  ${formatFindingsSummary(findings, filesAnalyzed)}\n`);
  for (const group of buildFileGroups(findings)) {
    console.log(`  ${group.path}`);
    for (const f of group.findings) printFinding(f);
  }
  console.log(`\n  ! ${disclaimer}`);
}

function printFinding(f: Finding): void {
  const sevLabel = f.severity === 'error' ? 'ERROR' : f.severity === 'warn' ? 'WARN ' : 'INFO ';
  console.log(`    ${sevLabel}  ${f.rule.padEnd(28)}  ${f.file}:${f.line}`);
  if (f.codeSnippet) console.log(`      ${f.codeSnippet}`);
  console.log(`      ${f.message}`);
  if (f.fix) console.log(`      Fix: ${f.fix}`);
  console.log('');
}

function formatScanSummary(scanResult: ScanResult): string {
  const total = scanResult.allParsedCount;
  const withImports = scanResult.files.length;
  return `Scanned ${total} ${total === 1 ? 'file' : 'files'} — found Redis/queue imports in ${withImports} ${withImports === 1 ? 'file' : 'files'}.`;
}

function formatFindingsSummary(findings: Finding[], filesAnalyzed: number): string {
  const errorCount = findings.filter(f => f.severity === 'error').length;
  const warnCount = findings.filter(f => f.severity === 'warn').length;
  const counts = [
    errorCount > 0 ? `${errorCount} error${errorCount > 1 ? 's' : ''}` : '',
    warnCount > 0 ? `${warnCount} warning${warnCount > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(', ');
  return `${counts} in ${filesAnalyzed} ${filesAnalyzed === 1 ? 'file' : 'files'} analysed.`;
}

function formatFindingMarkdown(f: Finding): string[] {
  const out: string[] = [];
  out.push(`#### ${f.severity.toUpperCase()} — \`${f.rule}\``);
  out.push(`**${f.file}:${f.line}**  `);
  out.push(f.message + '  ');
  if (f.codeSnippet) out.push('```', f.codeSnippet, '```');
  if (f.fix) out.push(`> Fix: ${f.fix}`);
  out.push('');
  return out;
}

function printSkippedSummary(scanResult: ScanResult, options: CliOptions): void {
  const k = scanResult.skipped.length;
  if (k === 0) return;
  if (options.verbose) {
    const { stats } = scanResult;
    console.log(
      `\nScanned ${stats.totalFiles} files in ${(stats.durationMs / 1000).toFixed(2)}s` +
        ` (parsed ${stats.parsedFiles}, skipped ${stats.skippedFiles}).`,
    );
    console.log('\nSkipped files:');
    for (const s of scanResult.skipped) {
      const line = s.line !== undefined ? `:${s.line}` : '';
      console.log(`  ! [${s.reason}] ${s.path}${line}: ${s.message}`);
    }
  } else {
    console.log(`\nSkipped ${k} ${k === 1 ? 'file' : 'files'} (use --verbose to see why).`);
  }
}
