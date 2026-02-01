export interface KPIData {
  label: string;
  value: number;
  previousValue?: number;
  prefix?: string;
  suffix?: string;
  format?: 'number' | 'currency' | 'percent';
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: number;
}

export interface ChartDataPoint {
  date: string;
  value: number;
  [key: string]: string | number;
}

export interface StakingTrendData {
  date: string;
  volume: number;
  count: number;
}

export interface NewVsReturningData {
  week: string;
  newStakers: number;
  returningStakers: number;
}

export interface RetentionCohortData {
  cohort: string;
  week0: number;
  week1: number;
  week2: number;
  week3: number;
  week4Plus: number;
}

export interface MonthlyComparisonData {
  month: string;
  volume: number;
  growth: number;
}

export interface TopStaker {
  rank: number;
  address: string;
  totalStaked: number;
  stakingCount: number;
  lastStaked: string;
}

export interface DuneQueryResult<T> {
  execution_id: string;
  query_id: number;
  state: 'QUERY_STATE_COMPLETED' | 'QUERY_STATE_PENDING' | 'QUERY_STATE_EXECUTING' | 'QUERY_STATE_FAILED';
  result?: {
    rows: T[];
    metadata: {
      column_names: string[];
      column_types: string[];
      row_count: number;
      result_set_bytes: number;
      total_row_count: number;
    };
  };
  error?: string;
}

export interface DashboardState {
  isLoading: boolean;
  error: string | null;
  lastUpdated: Date | null;
}

export type TimeRange = '7d' | '30d' | '90d' | 'all';
