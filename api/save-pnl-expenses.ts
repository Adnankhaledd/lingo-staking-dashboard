import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put } from '@vercel/blob';

const BLOB_FILENAME = 'pnl-expenses.json';

const ALLOWED_CATEGORIES = [
  'Team Compensation',
  'Infrastructure',
  'Marketing & Partnerships',
  'Gas Costs',
  'Legal & Compliance',
  'Other OpEx',
];

interface ExpenseEntry {
  month: string;
  category: string;
  amount: number;
  note?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  const requestPassword = req.headers['x-admin-password'] as string;

  if (!adminPassword || requestPassword !== adminPassword) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { expenses, budgets, team, projections, revenueModels, actuals, frozen, settings } = req.body as {
      expenses: ExpenseEntry[];
      budgets?: { month: string; category: string; budget: number }[];
      team?: { name: string; role: string; monthlySalary: number; startMonth: string; endMonth?: string }[];
      projections?: unknown[];
      revenueModels?: unknown[];
      actuals?: { month: string; actualRevenue: number; actualExpenses: number; notes?: string }[];
      frozen?: { frozenAt: string; months: Record<string, { revenue: number; expenses: number }> } | null;
      settings?: { treasuryBalance?: number; annualRevenueTarget?: number; annualExpenseTarget?: number };
    };

    if (!Array.isArray(expenses)) {
      return res.status(400).json({ error: 'expenses must be an array' });
    }

    for (const entry of expenses) {
      if (!/^\d{4}-\d{2}$/.test(entry.month)) {
        return res.status(400).json({ error: `Invalid month format: ${entry.month}` });
      }
      if (!ALLOWED_CATEGORIES.includes(entry.category)) {
        return res.status(400).json({ error: `Invalid category: ${entry.category}` });
      }
      if (typeof entry.amount !== 'number' || entry.amount < 0) {
        return res.status(400).json({ error: `Invalid amount for ${entry.month}/${entry.category}` });
      }
    }

    const payload = {
      expenses,
      budgets: budgets ?? [],
      team: team ?? [],
      projections: projections ?? [],
      revenueModels: revenueModels ?? [],
      actuals: actuals ?? [],
      frozen: frozen ?? null,
      settings: settings ?? {},
      updatedAt: new Date().toISOString(),
    };

    await put(BLOB_FILENAME, JSON.stringify(payload), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });

    return res.status(200).json({
      message: `Saved ${expenses.length} expenses, ${(budgets ?? []).length} budgets`,
      updatedAt: payload.updatedAt,
    });
  } catch (error) {
    console.error('Failed to save PnL expenses:', error);
    return res.status(500).json({
      error: 'Failed to save',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
