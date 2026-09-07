import { readFile, readdir, stat, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const out = fileURLToPath(new URL('../dist/', import.meta.url));
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : path.join(directory, entry.name)))).flat();
}
const files = await walk(out);
for (const name of ['index.html', 'setup.md', 'llms.txt', 'index.md', '.nojekyll', 'backdrop/pond/scene.js', 'backdrop/vendor/LICENSE', 'LICENSE.txt', 'assets/fonts/Geist-Variable.woff2', 'assets/fonts/GeistMono-Variable.woff2', 'assets/fonts/OFL.txt']) await access(path.join(out, name));
let bytes = 0;
for (const file of files) {
  bytes += (await stat(file)).size;
  assert(!/(?:^|\/)(?:qa|node_modules|scripts|PROMPTS[^/]*|README\.md)(?:\/|$)/.test(path.relative(out, file)), `Source file published: ${file}`);
  if (!/\.(html|css|js|md|txt)$/.test(file)) continue;
  const text = await readFile(file, 'utf8');
  assert(!/\{\{SITE_/.test(text), `Unresolved site URL in ${file}`);
  const refs = file.endsWith('.html') ? [...text.matchAll(/(?:href|src)="([^"#][^"]*)"/g)].map(match => match[1])
    : file.endsWith('.css') ? [...text.matchAll(/url\(['"]?([^)'" ]+)['"]?\)/g)].map(match => match[1])
    : file.endsWith('.js') ? [...text.matchAll(/(?:from\s+|import\()(['"])(\.\.?\/[^'"]+)\1/g)].map(match => match[2])
    : [...text.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
  for (const ref of refs) {
    if (/^(?:https?:|data:|#)/.test(ref)) continue;
    assert(!ref.startsWith('/'), `Root-relative link breaks project Pages: ${ref}`);
    const target = path.resolve(path.dirname(file), decodeURIComponent(ref.split(/[?#]/)[0] || '.'));
    assert(target === out.slice(0, -1) || target.startsWith(out), `Link escapes site: ${ref}`);
    await access(target.endsWith(path.sep) ? path.join(target, 'index.html') : target);
  }
}
assert(bytes < 5_000_000, `Static artifact exceeds 5 MB (${bytes} bytes)`);
assert.equal(files.filter(file => file.endsWith('.webp')).length, 12);
assert(!files.includes(path.join(out, 'backdrop/scene.js')), 'Retired open-water demo was published');
// Sharing crawlers read metadata without running the pond scene. Verify the actual image artifact.
const html = await readFile(path.join(out, 'index.html'), 'utf8');
const metadata = new Map([...html.matchAll(/<meta (?:name|property)="([^"]+)" content="([^"]*)"/g)].map(match => [match[1], match[2]]));
const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)[1];
const title = html.match(/<title>([^<]+)<\/title>/)[1];
for (const key of ['og:title', 'twitter:title']) assert.equal(metadata.get(key), title);
for (const key of ['og:description', 'twitter:description']) assert.equal(metadata.get(key), metadata.get('description'));
assert.equal(metadata.get('twitter:image'), metadata.get('og:image'));
assert(metadata.get('og:image:alt') && metadata.get('twitter:image:alt'));
const imageURL = new URL(metadata.get('og:image'));
assert(imageURL.href.startsWith(canonical), 'Share image must use the canonical project URL');
const image = await sharp(path.join(out, imageURL.href.slice(canonical.length))).metadata();
assert.equal(metadata.get('og:image:type'), `image/${image.format}`);
assert.equal(Number(metadata.get('og:image:width')), image.width);
assert.equal(Number(metadata.get('og:image:height')), image.height);
assert.equal(image.width, 1200); assert.equal(image.height, 630);
const setup = await readFile(path.join(out, 'setup.md'), 'utf8');
const api = await readFile(new URL('../../src/api.ts', import.meta.url), 'utf8');
assert(setup.includes('"kind":"appendMessage"') && api.includes("kind: z.literal('appendMessage')"));
for (const command of ['npm install -g @bassfish/cli', 'bassfish setup', 'codex mcp add bassfish -- bassfish mcp', 'claude mcp add --scope user bassfish -- bassfish mcp']) {
  assert(setup.includes(command));
  assert((await readFile(path.join(out, 'index.html'), 'utf8')).includes(command));
}
console.log(`Static checks passed: ${files.length} files, ${(bytes / 1e6).toFixed(2)} MB, relative links and agent instructions verified.`);
