import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Fifteen local routes, no external links, scripts, styles, or media. */
export const FIXTURE_ROUTES = [
  '/', '/section/a', '/section/b', '/missing-meta', '/noindex', '/canonical-bad',
  '/gone', '/redirect-one', '/redirect-two', '/destination', '/loop-one', '/loop-two',
  '/robots.txt', '/sitemap.xml', '/favicon.ico',
] as const;

export interface FixtureRequest { path: string; method: string; status: number }
export interface NativeTestSite {
  origin: string;
  expectedRoutes: readonly string[];
  requests: FixtureRequest[];
  close(): Promise<void>;
}

function page(title: string | null, description: string | null, heading: string | null, body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${title === null ? '' : `<title>${title}</title>`}${description === null ? '' : `<meta name="description" content="${description}">`}${head}</head><body>${heading === null ? '' : `<h1>${heading}</h1>`}${body}</body></html>`;
}

/** Bind only to loopback on a fresh port. Starting this fixture never contacts the native app. */
export async function startNativeTestSite(): Promise<NativeTestSite> {
  let origin = '';
  const requests: FixtureRequest[] = [];
  const server = createServer((request, response) => {
    let path: string;
    try { path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname; }
    catch { response.writeHead(400); response.end('Invalid request URL'); return; }
    let status = 200;
    let contentType = 'text/html; charset=utf-8';
    let content = '';
    const links = ['/section/a', '/section/b', '/missing-meta', '/noindex', '/canonical-bad', '/gone', '/redirect-one', '/loop-one', '/sitemap.xml'];
    switch (path) {
      case '/':
        content = page('JEStats native fixture', 'Small controlled integration fixture.', 'Local crawl fixture', links.map(url => `<a href="${url}">${url}</a>`).join(' ')); break;
      case '/section/a': case '/section/b':
        content = page('Shared duplicate title', 'Shared duplicate description.', 'Shared heading', '<a href="/gone">Shared broken target</a> <a href="/redirect-one">Redirect chain</a> <a href="/">Home</a>'); break;
      case '/missing-meta': content = page(null, null, null, '<p>Metadata intentionally absent.</p><a href="/">Home</a>'); break;
      case '/noindex': content = page('Intentional noindex', 'Intentional indexing exclusion.', 'Noindex example', '<a href="/">Home</a>', '<meta name="robots" content="noindex,follow">'); break;
      case '/canonical-bad': content = page('Invalid canonical target', 'Canonical target returns 404.', 'Canonical example', '<a href="/">Home</a>', `<link rel="canonical" href="${origin}/gone">`); break;
      case '/gone': case '/favicon.ico': status = 404; content = page('Missing fixture URL', null, 'Not found', '<p>Controlled missing target.</p>'); break;
      case '/redirect-one': status = 301; response.setHeader('location', '/redirect-two'); break;
      case '/redirect-two': status = 302; response.setHeader('location', '/destination'); break;
      case '/destination': content = page('Redirect destination', 'Working redirect destination.', 'Destination', '<a href="/">Home</a>'); break;
      case '/loop-one': status = 301; response.setHeader('location', '/loop-two'); break;
      case '/loop-two': status = 302; response.setHeader('location', '/loop-one'); break;
      case '/robots.txt': contentType = 'text/plain; charset=utf-8'; content = `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`; break;
      case '/sitemap.xml': contentType = 'application/xml; charset=utf-8'; content = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/section/a', '/section/b', '/noindex', '/gone'].map(url => `<url><loc>${origin}${url}</loc></url>`).join('')}</urlset>`; break;
      default: status = 404; contentType = 'text/plain; charset=utf-8'; content = 'Unknown fixture route';
    }
    if (requests.length < 256) requests.push({ path, method: request.method ?? 'GET', status });
    response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : content);
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin, expectedRoutes: FIXTURE_ROUTES, requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
