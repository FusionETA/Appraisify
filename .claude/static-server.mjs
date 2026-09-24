import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const ROOT = process.cwd();
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.pdf':'application/pdf', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg' };
createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, p === '/' ? '/views/dashboard.html' : p);
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(8765, () => console.log('static server on http://localhost:8765'));
