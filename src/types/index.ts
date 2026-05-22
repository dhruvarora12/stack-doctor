export type ClientCategory = 'redis-client' | 'redis-queue';

export type { ImportStyle, ImportRecord, SkippedFile, ScannedFile, ScanStats, ScanResult } from './scan.js';
export type { FindingSeverity, FindingRule, Finding, CacheAnalysisResult, QueueAnalysisResult } from './findings.js';
export type { LiveRedisResult, ScannedKey, NamespaceEntry, KeyScanResult, QueueScanEntry, QueueScanResult } from './live.js';
export type { CrossModeInsightKind, CrossModeInsight, CrossModeResult } from './cross-mode.js';
export type { Recommendation, RecommendationsResult } from './recommendations.js';

export interface DetectedClient {
  name: string;
  version: string;
  category: ClientCategory;
  isDirect: boolean;
}

export interface DetectionResult {
  isNodeProject: boolean;
  packageJsonPath: string | null;
  hasRedis: boolean;
  hasQueues: boolean;
  clients: DetectedClient[];
  warnings: string[];
}

export interface CliOptions {
  output: 'text' | 'json' | 'markdown';
  verbose: boolean;
  color: boolean;
  skipCache: boolean;
  skipQueues: boolean;
  live: boolean;
  redisUrl: string | undefined;
  envFile: string;
  sampleSize: number;
  idleThreshold: number;
}
