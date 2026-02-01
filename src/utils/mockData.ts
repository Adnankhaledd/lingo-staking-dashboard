import type {
  KPIData,
  StakingTrendData,
  NewVsReturningData,
  RetentionCohortData,
  MonthlyComparisonData,
  TopStaker,
} from '../types';

// Generate dates for the last N days
function generateDates(days: number): string[] {
  const dates: string[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    dates.push(date.toISOString().split('T')[0]);
  }
  return dates;
}

// Generate random number within range
function randomInRange(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// KPI Data
export const mockKPIData: KPIData[] = [
  {
    label: 'Total LINGO Staked',
    value: 847293847,
    previousValue: 792847293,
    format: 'number',
    suffix: ' LINGO',
    trend: 'up',
    trendValue: 6.87,
  },
  {
    label: 'Unique Stakers',
    value: 8247293,
    previousValue: 7892847,
    format: 'number',
    trend: 'up',
    trendValue: 4.49,
  },
  {
    label: 'New This Week',
    value: 34829,
    previousValue: 28472,
    format: 'number',
    trend: 'up',
    trendValue: 22.32,
  },
  {
    label: 'Retention Rate',
    value: 73.4,
    previousValue: 71.2,
    format: 'percent',
    trend: 'up',
    trendValue: 3.09,
  },
];

// Staking Trend Data (90 days)
export const mockStakingTrendData: StakingTrendData[] = generateDates(90).map(
  (date, index) => ({
    date,
    volume: randomInRange(5000000, 15000000) + index * 50000,
    count: randomInRange(5000, 15000) + index * 100,
  })
);

// New vs Returning Stakers (12 weeks)
export const mockNewVsReturningData: NewVsReturningData[] = Array.from(
  { length: 12 },
  (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() - (11 - i) * 7);
    return {
      week: date.toISOString().split('T')[0],
      newStakers: randomInRange(20000, 45000),
      returningStakers: randomInRange(50000, 80000),
    };
  }
);

// Retention Cohort Data
export const mockRetentionCohortData: RetentionCohortData[] = [
  { cohort: 'Week 1', week0: 100, week1: 72, week2: 58, week3: 48, week4Plus: 41 },
  { cohort: 'Week 2', week0: 100, week1: 75, week2: 61, week3: 52, week4Plus: 44 },
  { cohort: 'Week 3', week0: 100, week1: 68, week2: 55, week3: 45, week4Plus: 38 },
  { cohort: 'Week 4', week0: 100, week1: 71, week2: 59, week3: 49, week4Plus: 42 },
  { cohort: 'Week 5', week0: 100, week1: 74, week2: 62, week3: 51, week4Plus: 45 },
  { cohort: 'Week 6', week0: 100, week1: 69, week2: 56, week3: 47, week4Plus: 40 },
  { cohort: 'Week 7', week0: 100, week1: 73, week2: 60, week3: 50, week4Plus: 43 },
  { cohort: 'Week 8', week0: 100, week1: 76, week2: 63, week3: 53, week4Plus: 46 },
];

// Monthly Comparison Data
export const mockMonthlyComparisonData: MonthlyComparisonData[] = [
  { month: 'Aug 2024', volume: 142500000, growth: 0 },
  { month: 'Sep 2024', volume: 158700000, growth: 11.4 },
  { month: 'Oct 2024', volume: 187200000, growth: 18.0 },
  { month: 'Nov 2024', volume: 203400000, growth: 8.7 },
  { month: 'Dec 2024', volume: 234800000, growth: 15.4 },
  { month: 'Jan 2025', volume: 267300000, growth: 13.8 },
];

// Top Stakers
export const mockTopStakers: TopStaker[] = [
  {
    rank: 1,
    address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2e3d9',
    totalStaked: 25847293,
    stakingCount: 47,
    lastStaked: '2025-01-28',
  },
  {
    rank: 2,
    address: '0x8ba1f109551bD432803012645Hac136c22B4b72',
    totalStaked: 18293847,
    stakingCount: 32,
    lastStaked: '2025-01-29',
  },
  {
    rank: 3,
    address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    totalStaked: 15729384,
    stakingCount: 28,
    lastStaked: '2025-01-30',
  },
  {
    rank: 4,
    address: '0x6B175474E89094C44Da98b954EedfaCE16a9684D',
    totalStaked: 12847293,
    stakingCount: 41,
    lastStaked: '2025-01-27',
  },
  {
    rank: 5,
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    totalStaked: 10293847,
    stakingCount: 19,
    lastStaked: '2025-01-29',
  },
  {
    rank: 6,
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    totalStaked: 9847293,
    stakingCount: 25,
    lastStaked: '2025-01-28',
  },
  {
    rank: 7,
    address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    totalStaked: 8293847,
    stakingCount: 15,
    lastStaked: '2025-01-26',
  },
  {
    rank: 8,
    address: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
    totalStaked: 7729384,
    stakingCount: 22,
    lastStaked: '2025-01-30',
  },
  {
    rank: 9,
    address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
    totalStaked: 6847293,
    stakingCount: 18,
    lastStaked: '2025-01-25',
  },
  {
    rank: 10,
    address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F985',
    totalStaked: 5293847,
    stakingCount: 12,
    lastStaked: '2025-01-29',
  },
];

// Weekly unique stakers
export const mockWeeklyUniqueStakers = Array.from({ length: 12 }, (_, i) => {
  const date = new Date();
  date.setDate(date.getDate() - (11 - i) * 7);
  return {
    week: date.toISOString().split('T')[0],
    uniqueStakers: randomInRange(150000, 250000) + i * 5000,
  };
});
