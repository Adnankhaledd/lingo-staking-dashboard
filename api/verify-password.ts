import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  const requestPassword = req.headers['x-admin-password'] as string;

  if (!adminPassword || requestPassword !== adminPassword) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return res.status(200).json({ ok: true });
}
