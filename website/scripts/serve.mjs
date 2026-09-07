import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.env.PORT || 8081);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
createServer(async (req, res) => {
  try {
    let name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (name === '/') { res.writeHead(302, { Location: '/bassfish/' }); res.end(); return; }
    if (!name.startsWith('/bassfish/')) throw new Error('Not found');
    name = path.resolve(root, name.slice('/bassfish/'.length));
    if (name !== root.slice(0, -1) && !name.startsWith(root)) throw new Error('Not found');
    if ((await stat(name)).isDirectory()) name = path.join(name, 'index.html');
    const body = await readFile(name);
    res.writeHead(200, { 'Content-Type': types[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Bassfish: http://127.0.0.1:${port}/bassfish/`));
