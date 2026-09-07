import { mkdir, readFile, writeFile, cp, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const site = fileURLToPath(new URL('../', import.meta.url));
const root = path.resolve(site, '..');
const out = path.join(site, 'dist');
const pond = path.join(root, 'marketing/backdrop/pond');
const siteURL = new URL(process.env.BASSFISH_SITE_URL || 'https://tfukaza.github.io/bassfish/');
if (!['http:', 'https:'].includes(siteURL.protocol) || siteURL.search || siteURL.hash || !siteURL.pathname.endsWith('/')) {
  throw new Error('BASSFISH_SITE_URL must be an HTTP(S) URL ending in /, without a query or fragment.');
}
await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'assets'), { recursive: true });
await mkdir(path.join(out, 'backdrop/pond'), { recursive: true });
for (const name of ['index.html', 'style.css', 'main.js', 'story-scene.js', 'story-timing.js', 'terminal-story.js', 'setup.md', 'llms.txt', 'index.md']) {
  const source = await readFile(path.join(site, name), 'utf8');
  const text = source.replaceAll('{{SITE_URL}}', siteURL.href).replaceAll('{{SITE_HOST_PATH}}', `${siteURL.host}${siteURL.pathname}`);
  await writeFile(path.join(out, name), text);
}
await writeFile(path.join(out, '.nojekyll'), '');
await cp(path.join(root, 'marketing/logo/horizontal-light.svg'), path.join(out, 'assets/logo.svg'));
await cp(path.join(root, 'marketing/logo/icon-light.svg'), path.join(out, 'assets/icon.svg'));
await cp(path.join(root, 'marketing/backdrop/vendor'), path.join(out, 'backdrop/vendor'), { recursive: true });
await cp(path.join(root, 'LICENSE'), path.join(out, 'LICENSE.txt'));
await cp(path.join(site, 'assets/fonts'), path.join(out, 'assets/fonts'), { recursive: true });

for (const name of ['scene.js', 'habitat.js', 'bass.js', 'foliage.js', 'landforms.js', 'dimensions.js', 'preview.js', 'index.html', 'style.css']) {
  let text = await readFile(path.join(pond, name), 'utf8');
  if (['habitat.js', 'bass.js', 'foliage.js'].includes(name)) {
    // Only the published copy uses WebP; the art preview keeps its source PNGs.
    if ((text.match(/\.png(?=`)/g) ?? []).length !== 1) throw new Error(`Review texture URLs in ${name} before building.`);
    text = text.replace(/\.png(?=`)/g, '.webp');
  }
  if (name === 'index.html') text = text.replace('../../logo/icon-light.svg', '../../assets/icon.svg');
  await writeFile(path.join(out, 'backdrop/pond', name), text);
}
await cp(path.join(root, 'marketing/backdrop/index.html'), path.join(out, 'backdrop/index.html'));
await sharp(path.join(pond, 'poster.jpg')).resize({ width: 1440, withoutEnlargement: true }).jpeg({ quality: 85, mozjpeg: true }).toFile(path.join(out, 'assets/pond.jpg'));
await cp(path.join(out, 'assets/pond.jpg'), path.join(out, 'backdrop/pond/poster.jpg'));

const images = [
  'textures/soil-albedo-v2', 'textures/grass-albedo-v2', 'textures/sand-albedo-v1', 'textures/rock-albedo-v1',
  ...['bank-grass', 'bank-shrub', 'bank-flowers', 'water-plants', 'cattails', 'lily-pad'].map(name => `foliage/${name}-v2`),
  'fish/bass-body-v2', 'fish/bass-fins-v1',
];
let sourceBytes = 0, outputBytes = 0;
for (const name of images) {
  const target = path.join(out, 'backdrop/pond', `${name}.webp`);
  await mkdir(path.dirname(target), { recursive: true });
  const original = path.join(pond, `${name}.png`);
  const result = await sharp(original).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 88, alphaQuality: 100, effort: 6 }).toFile(target);
  sourceBytes += (await stat(original)).size; outputBytes += result.size;
}
console.log(`Built ${out}`);
console.log(`12 texture maps: ${(sourceBytes / 1e6).toFixed(2)} MB PNG → ${(outputBytes / 1e6).toFixed(2)} MB WebP. Canonical URL: ${siteURL.href}`);
