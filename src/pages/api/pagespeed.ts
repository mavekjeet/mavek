export const prerender = false;

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const GET: APIRoute = async ({ request }) => {
  const headers = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  };

  try {
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
