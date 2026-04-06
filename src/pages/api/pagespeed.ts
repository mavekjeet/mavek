export const prerender = false;

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

// --- IP-based rate limiting (in-memory, resets on worker restart) ---
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 5;         // max requests per IP per window
const RATE_WINDOW_MS = 60_000; // 1 minute window
const DAILY_QUOTA = 800;      // global daily cap (Google free tier = 25k/day, keep headroom)
let dailyCount = 0;
let dailyResetAt = Date.now() + 86_400_000;

function checkRateLimit(ip: string): string | null {
  const now = Date.now();

  // Reset daily counter if past midnight
  if (now > dailyResetAt) {
    dailyCount = 0;
    dailyResetAt = now + 86_400_000;
  }

  // Check global daily quota
  if (dailyCount >= DAILY_QUOTA) {
    return 'Daily usage limit reached. Please try again tomorrow.';
  }

  // Check per-IP rate limit
  const entry = rateLimitMap.get(ip);
  if (entry && now < entry.resetAt) {
    if (entry.count >= RATE_LIMIT) {
      const waitSec = Math.ceil((entry.resetAt - now) / 1000);
      return `Rate limit exceeded. Try again in ${waitSec} seconds.`;
    }
    entry.count++;
  } else {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
  }

  // Prune stale entries periodically (keep map from growing unbounded)
  if (rateLimitMap.size > 500) {
    for (const [key, val] of rateLimitMap) {
      if (now > val.resetAt) rateLimitMap.delete(key);
    }
  }

  dailyCount++;
  return null;
}

export const GET: APIRoute = async ({ request }) => {
  const headers = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  };

  try {
    // Rate limit by IP
    const ip = request.headers.get('cf-connecting-ip')
      || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || 'unknown';
    const rateLimitError = checkRateLimit(ip);
    if (rateLimitError) {
      return new Response(
        JSON.stringify({ error: rateLimitError }),
        { status: 429, headers: { ...headers, 'retry-after': '60' } }
      );
    }

    const params = new URL(request.url).searchParams;
    const url = params.get('url');
    const strategy = params.get('strategy') || 'mobile';

    if (!url) {
      return new Response(
        JSON.stringify({ error: 'url parameter is required' }),
        { status: 400, headers }
      );
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid URL format. Include https://' }),
        { status: 400, headers }
      );
    }

    const apiKey = env.PAGESPEED_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'API key not configured' }),
        { status: 500, headers }
      );
    }

    const categories = ['performance', 'accessibility', 'best-practices', 'seo'];
    const categoryParams = categories.map(c => `category=${c}`).join('&');
    const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&${categoryParams}&strategy=${strategy}&key=${apiKey}`;

    const response = await fetch(apiUrl);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const message = (errorData as any)?.error?.message || 'Google API request failed';
      return new Response(
        JSON.stringify({ error: message }),
        { status: response.status, headers }
      );
    }

    const data = await response.json();

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        ...headers,
        'cache-control': 'public, max-age=300',
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'Failed to fetch PageSpeed data', detail: String(error) }),
      { status: 500, headers }
    );
  }
};
