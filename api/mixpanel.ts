import type { VercelRequest, VercelResponse } from '@vercel/node';

const MIXPANEL_API_SECRET = process.env.MIXPANEL_API_SECRET || '010125f09fef119ad08d0eb062be12b6';
const PROJECT_ID = '3623820';
const REPORT_ID = '75454495';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { type } = req.query;

  try {
    let data;

    if (type === 'dau') {
      // Fetch DAU report
      const response = await fetch(
        `https://eu.mixpanel.com/api/2.0/insights?project_id=${PROJECT_ID}&bookmark_id=${REPORT_ID}`,
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': `Basic ${Buffer.from(MIXPANEL_API_SECRET + ':').toString('base64')}`,
          },
        }
      );
      data = await response.json();
    } else if (type === 'wau') {
      // Fetch WAU
      const today = new Date();
      const lastWeek = new Date(today);
      lastWeek.setDate(lastWeek.getDate() - 7);

      const params = new URLSearchParams({
        project_id: PROJECT_ID,
        event: JSON.stringify(['Wallet Connected']),
        type: 'unique',
        unit: 'week',
        from_date: lastWeek.toISOString().split('T')[0],
        to_date: today.toISOString().split('T')[0],
      });

      const response = await fetch(
        `https://eu.mixpanel.com/api/2.0/events?${params}`,
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': `Basic ${Buffer.from(MIXPANEL_API_SECRET + ':').toString('base64')}`,
          },
        }
      );
      data = await response.json();
    } else if (type === 'mau') {
      // Fetch MAU
      const today = new Date();
      const lastMonth = new Date(today);
      lastMonth.setDate(lastMonth.getDate() - 30);

      const params = new URLSearchParams({
        project_id: PROJECT_ID,
        event: JSON.stringify(['Wallet Connected']),
        type: 'unique',
        unit: 'month',
        from_date: lastMonth.toISOString().split('T')[0],
        to_date: today.toISOString().split('T')[0],
      });

      const response = await fetch(
        `https://eu.mixpanel.com/api/2.0/events?${params}`,
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': `Basic ${Buffer.from(MIXPANEL_API_SECRET + ':').toString('base64')}`,
          },
        }
      );
      data = await response.json();
    } else {
      return res.status(400).json({ error: 'Invalid type. Use: dau, wau, or mau' });
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error('Mixpanel API error:', error);
    return res.status(500).json({ error: 'Failed to fetch Mixpanel data' });
  }
}
