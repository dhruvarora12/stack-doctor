import type { FindingRule } from './findings.js';

export interface Recommendation {
  priority: 1 | 2 | 3;
  title: string;
  why: string;
  fix: string;
  effort: 'low' | 'medium' | 'high';
  relatedRule?: FindingRule;
  confirmedByLive: boolean;
}

export interface RecommendationsResult {
  recommendations: Recommendation[];
  quickWins: Recommendation[];
  totalCount: number;
  priority1Count: number;
  priority2Count: number;
  priority3Count: number;
}
