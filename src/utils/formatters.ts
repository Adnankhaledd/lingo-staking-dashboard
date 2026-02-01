import { format, parseISO, isValid } from 'date-fns';

/**
 * Format large numbers with abbreviations (K, M, B)
 */
export function formatNumber(num: number | null | undefined, decimals = 1): string {
  if (num === null || num === undefined || isNaN(num)) return '—';

  const absNum = Math.abs(num);

  if (absNum >= 1_000_000_000) {
    return (num / 1_000_000_000).toFixed(decimals) + 'B';
  }
  if (absNum >= 1_000_000) {
    return (num / 1_000_000).toFixed(decimals) + 'M';
  }
  if (absNum >= 1_000) {
    return (num / 1_000).toFixed(decimals) + 'K';
  }

  return num.toFixed(decimals);
}

/**
 * Format number with commas
 */
export function formatWithCommas(num: number | null | undefined): string {
  if (num === null || num === undefined || isNaN(num)) return '—';
  return num.toLocaleString('en-US');
}

/**
 * Format currency (USD)
 */
export function formatCurrency(num: number | null | undefined, decimals = 2): string {
  if (num === null || num === undefined || isNaN(num)) return '—';

  const absNum = Math.abs(num);

  if (absNum >= 1_000_000_000) {
    return '$' + (num / 1_000_000_000).toFixed(decimals) + 'B';
  }
  if (absNum >= 1_000_000) {
    return '$' + (num / 1_000_000).toFixed(decimals) + 'M';
  }
  if (absNum >= 1_000) {
    return '$' + (num / 1_000).toFixed(decimals) + 'K';
  }

  return '$' + num.toFixed(decimals);
}

/**
 * Format percentage
 */
export function formatPercent(num: number | null | undefined, decimals = 1): string {
  if (num === null || num === undefined || isNaN(num)) return '—';
  return num.toFixed(decimals) + '%';
}

/**
 * Format date for charts (short format)
 */
export function formatChartDate(dateStr: string | Date): string {
  try {
    const date = typeof dateStr === 'string' ? parseISO(dateStr) : dateStr;
    if (!isValid(date)) return String(dateStr);
    return format(date, 'MMM d');
  } catch {
    return String(dateStr);
  }
}

/**
 * Format date for week display
 */
export function formatWeekDate(dateStr: string | Date): string {
  try {
    const date = typeof dateStr === 'string' ? parseISO(dateStr) : dateStr;
    if (!isValid(date)) return String(dateStr);
    return 'Week of ' + format(date, 'MMM d');
  } catch {
    return String(dateStr);
  }
}

/**
 * Format full date
 */
export function formatFullDate(dateStr: string | Date): string {
  try {
    const date = typeof dateStr === 'string' ? parseISO(dateStr) : dateStr;
    if (!isValid(date)) return String(dateStr);
    return format(date, 'MMMM d, yyyy');
  } catch {
    return String(dateStr);
  }
}

/**
 * Format date with time
 */
export function formatDateTime(dateStr: string | Date): string {
  try {
    const date = typeof dateStr === 'string' ? parseISO(dateStr) : dateStr;
    if (!isValid(date)) return String(dateStr);
    return format(date, 'MMM d, yyyy h:mm a');
  } catch {
    return String(dateStr);
  }
}

/**
 * Truncate wallet address
 */
export function truncateAddress(address: string, startChars = 6, endChars = 4): string {
  if (!address) return '—';
  if (address.length <= startChars + endChars) return address;
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
}

/**
 * Calculate percentage change
 */
export function calculateChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

/**
 * Export data to CSV
 */
export function exportToCSV<T extends object>(data: T[], filename: string): void {
  if (!data || data.length === 0) return;

  const headers = Object.keys(data[0] as object);
  const csvContent = [
    headers.join(','),
    ...data.map(row =>
      headers.map(header => {
        const value = (row as Record<string, unknown>)[header];
        // Escape quotes and wrap in quotes if contains comma
        const stringValue = String(value ?? '');
        if (stringValue.includes(',') || stringValue.includes('"')) {
          return `"${stringValue.replace(/"/g, '""')}"`;
        }
        return stringValue;
      }).join(',')
    )
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${filename}_${format(new Date(), 'yyyy-MM-dd')}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}
