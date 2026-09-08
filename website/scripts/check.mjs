import { readFile, readdir, stat, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const out = fileURLToPath(new URL('../dist/', import.meta.url));
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(entry =>
        entry.isDirectory()
          ? walk(path.join(directory, entry.name))
          : path.join(directory, entry.name),
      ),
    )
  ).flat();
}
const files = await walk(out);
for (const name of [
  'index.html',
  'docs.html',
  'docs.css',
  'docs.js',
  'setup.md',
  'llms.txt',
  'index.md',
  '.nojekyll',
  'backdrop/pond/scene.js',
  'backdrop/vendor/LICENSE',
  'LICENSE.txt',
  'assets/fonts/Geist-Variable.woff2',
  'assets/fonts/GeistMono-Variable.woff2',
  'assets/fonts/OFL.txt',
])
  await access(path.join(out, name));
let bytes = 0;
for (const file of files) {
  bytes += (await stat(file)).size;
  assert(
    !/(?:^|\/)(?:qa|node_modules|scripts|PROMPTS[^/]*|README\.md)(?:\/|$)/.test(
      path.relative(out, file),
    ),
    `Source file published: ${file}`,
  );
  if (!/\.(html|css|js|md|txt)$/.test(file)) continue;
  const text = await readFile(file, 'utf8');
  assert(!/\{\{SITE_/.test(text), `Unresolved site URL in ${file}`);
  const refs = file.endsWith('.html')
    ? [...text.matchAll(/(?:href|src)="([^"#][^"]*)"/g)].map(match => match[1])
    : file.endsWith('.css')
      ? [...text.matchAll(/url\(['"]?([^)'" ]+)['"]?\)/g)].map(match => match[1])
      : file.endsWith('.js')
        ? [...text.matchAll(/(?:from\s+|import\()(['"])(\.\.?\/[^'"]+)\1/g)].map(match => match[2])
        : [...text.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
  for (const ref of refs) {
    if (/^(?:https?:|data:|#)/.test(ref)) continue;
    assert(!ref.startsWith('/'), `Root-relative link breaks project Pages: ${ref}`);
    const target = path.resolve(
      path.dirname(file),
      decodeURIComponent(ref.split(/[?#]/)[0] || '.'),
    );
    assert(target === out.slice(0, -1) || target.startsWith(out), `Link escapes site: ${ref}`);
    await access(target.endsWith(path.sep) ? path.join(target, 'index.html') : target);
  }
}
assert(bytes < 5_000_000, `Static artifact exceeds 5 MB (${bytes} bytes)`);
assert.equal(
  files.filter(file => file.endsWith('.webp') && file.startsWith(path.join(out, 'backdrop')))
    .length,
  12,
);
assert(
  !files.includes(path.join(out, 'backdrop/scene.js')),
  'Retired open-water demo was published',
);
// Sharing crawlers read metadata without running the pond scene. Verify the actual image artifact.
const html = await readFile(path.join(out, 'index.html'), 'utf8');
const metadata = new Map();
for (const tag of html.matchAll(/<meta\b[^>]*>/g)) {
  const attributes = new Map(
    [...tag[0].matchAll(/\b(name|property|content)="([^"]*)"/g)].map(match => [match[1], match[2]]),
  );
  const key = attributes.get('name') ?? attributes.get('property');
  const content = attributes.get('content');
  if (key && content !== undefined) metadata.set(key, content);
}
const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)[1];
const title = html.match(/<title>([^<]+)<\/title>/)[1];
for (const key of ['og:title', 'twitter:title']) assert.equal(metadata.get(key), title);
for (const key of ['og:description', 'twitter:description'])
  assert.equal(metadata.get(key), metadata.get('description'));
assert.equal(metadata.get('twitter:image'), metadata.get('og:image'));
assert(metadata.get('og:image:alt') && metadata.get('twitter:image:alt'));
const imageURL = new URL(metadata.get('og:image'));
assert(imageURL.href.startsWith(canonical), 'Share image must use the canonical project URL');
const image = await sharp(path.join(out, imageURL.href.slice(canonical.length))).metadata();
assert.equal(metadata.get('og:image:type'), `image/${image.format}`);
assert.equal(Number(metadata.get('og:image:width')), image.width);
assert.equal(Number(metadata.get('og:image:height')), image.height);
assert.equal(image.width, 1200);
assert.equal(image.height, 630);
const setup = await readFile(path.join(out, 'setup.md'), 'utf8');
const docs = await readFile(path.join(out, 'docs.html'), 'utf8');
const indexText = await readFile(path.join(out, 'index.md'), 'utf8');
const llms = await readFile(path.join(out, 'llms.txt'), 'utf8');
const packageManifest = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
);
const mcpApi = await readFile(new URL('../../src/mcp-api.ts', import.meta.url), 'utf8');
const schemaBody = mcpApi.match(/export const mcpSchemas = \{([\s\S]*?)\n\} satisfies Record/);
assert(schemaBody, 'Could not locate the public MCP schema registry');
const toolNames = [...schemaBody[1].matchAll(/^  ([A-Za-z][A-Za-z0-9]*):/gm)].map(
  match => match[1],
);
const documentedTools = [...docs.matchAll(/data-tool="([^"]+)"/g)].map(match => match[1]);
assert.equal(toolNames.length, 11);
assert.deepEqual(
  documentedTools,
  toolNames,
  'Documentation tool inventory must match src/mcp-api.ts',
);
assert(docs.includes('v' + packageManifest.version));
assert(setup.includes('version ' + packageManifest.version));
assert(
  setup.includes('"kind":"appendMessage"') && mcpApi.includes("kind: z.literal('appendMessage')"),
);
assert(setup.includes('"resourceType":"ticket"') && setup.includes('"type":"files"'));
const publishedGuidance = [html, docs, setup, indexText, llms].join('\n');
for (const [pattern, label] of [
  [/v0\.3\.0/, 'v0.3 label'],
  [/\b13(?:-tool| Bassfish tools)/, '13-tool claim'],
  [/"resourceType":"note"/, 'retired note resource'],
  [/"type":"note"/, 'retired note turn'],
  [/\b(?:appendNote|replaceNote|bassfish note)\b/, 'retired note operation'],
  [/getContext\.pendingTurn(?!s)/, 'singular pendingTurn field'],
])
  assert(!pattern.test(publishedGuidance), 'Published guidance contains ' + label);
for (const command of [
  'npm install -g @bassfish/cli',
  'bassfish setup',
  'codex mcp add bassfish -- bassfish mcp',
  'claude plugin install bassfish@bassfish --scope user',
]) {
  assert(setup.includes(command));
  assert(html.includes(command));
  assert(docs.includes(command));
}
console.log(
  `Static checks passed: ${files.length} files, ${(bytes / 1e6).toFixed(2)} MB, relative links and agent instructions verified.`,
);
