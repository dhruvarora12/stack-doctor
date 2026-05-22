import type { FindingRule, FindingSeverity } from './findings.js';

export type CrossModeInsightKind =
  | 'confirms-finding'
  | 'contradicts-finding'
  | 'new-finding'
  | 'all-clear';

export interface CrossModeInsight {
  kind: CrossModeInsightKind;
  title: string;
  detail: string;
  relatedRule?: FindingRule;
  severity: FindingSeverity;
}

export interface CrossModeResult {
  insights: CrossModeInsight[];
  confirmedCount: number;
  contradictedCount: number;
  newFindingCount: number;
}
