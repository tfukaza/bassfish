import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  C,
  svg,
  fish,
  logo,
  overview,
  workflow,
  brandSheet,
  frame,
  events,
  DURATION,
  FPS,
  GIF_START,
  GIF_DURATION,
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  GIF_WIDTH,
  README_GIF_WIDTH,
  README_GIF_FPS,
  snapshots,
} from './artwork.mjs';
const require = createRequire(import.meta.url);
const sharp = process.env.BASSFISH_SHARP_MODULE
  ? require(process.env.BASSFISH_SHARP_MODULE)
  : require('sharp');
const root = fileURLToPath(new URL('../', import.meta.url));
for (const dir of ['logo', 'video', 'qa']) await mkdir(path.join(root, dir), { recursive: true });
async function exportSvg(name, source) {
  await writeFile(path.join(root, name + '.svg'), source);
  await sharp(Buffer.from(source))
    .png()
    .toFile(path.join(root, name + '.png'));
}
for (const [variant, ink, mark] of [
  ['light', C.ink, C.ink],
  ['dark', C.white, C.white],
  ['mono-black', '#000', '#000'],
  ['mono-white', '#fff', '#fff'],
]) {
  await exportSvg(
    `logo/icon-${variant}`,
    svg(128, 128, `Bassfish silhouette, ${variant}`, fish(8, 8, 112, mark), null),
  );
  await exportSvg(
    `logo/horizontal-${variant}`,
    svg(500, 128, `Bassfish wordmark, ${variant}`, logo(8, 8, 112, ink, mark), null),
  );
}
await exportSvg(
  'logo/avatar',
  svg(512, 512, 'Bassfish repository avatar', fish(40, 40, 432, C.white), C.ink),
);
await exportSvg('readme-banner', overview());
await exportSvg('social-preview', overview(1280, 640));
await exportSvg('workflow', workflow());
await exportSvg('brand-sheet', brandSheet());
await exportSvg('video/poster', frame(14.8));
const tileWidth = 480,
  tileHeight = Math.round((tileWidth * VIDEO_HEIGHT) / VIDEO_WIDTH),
  tileStride = tileHeight + 30;
const tiles = [];
for (let i = 0; i < snapshots.length; i++) {
  const data = await sharp(Buffer.from(frame(snapshots[i])))
    .resize(tileWidth, tileHeight, { fit: 'contain', background: C.white })
    .png()
    .toBuffer();
  tiles.push({ input: data, left: (i % 3) * 480, top: Math.floor(i / 3) * tileStride });
  const label = svg(
    480,
    30,
    `Time ${snapshots[i]}`,
    `<text x="12" y="22" font-family="Arial" font-size="18" fill="${C.ink}">${snapshots[i].toFixed(1)} seconds</text>`,
  );
  tiles.push({
    input: Buffer.from(label),
    left: (i % 3) * 480,
    top: Math.floor(i / 3) * tileStride + tileHeight,
  });
}
await sharp({
  create: {
    width: 1440,
    height: Math.ceil(snapshots.length / 3) * tileStride,
    channels: 4,
    background: C.ink,
  },
})
  .composite(tiles)
  .png()
  .toFile(path.join(root, 'qa/video-contact-sheet.png'));
const small = [];
for (const [j, bg, fg] of [
  [0, C.white, C.ink],
  [1, C.ink, C.white],
]) {
  small.push({
    input: Buffer.from(svg(320, 200, 'Icon proof background', '', bg)),
    left: j * 320,
    top: 0,
  });
  for (const [i, size] of [24, 32, 48].entries()) {
    const x = 36 + i * 92;
    small.push({
      input: Buffer.from(svg(size, size, `Bassfish at ${size}px`, fish(0, 0, size, fg), null)),
      left: j * 320 + x,
      top: 65,
    });
    small.push({
      input: Buffer.from(
        svg(
          80,
          28,
          'Size label',
          `<text x="0" y="20" font-family="Arial" font-size="14" fill="${fg}">${size} px</text>`,
          null,
        ),
      ),
      left: j * 320 + x,
      top: 130,
    });
  }
}
await sharp({ create: { width: 640, height: 200, channels: 4, background: C.white } })
  .composite(small)
  .png()
  .toFile(path.join(root, 'qa/small-icons.png'));
await sharp(path.join(root, 'readme-banner.png'))
  .resize(800)
  .toFile(path.join(root, 'qa/banner-800.png'));
await sharp(path.join(root, 'social-preview.png'))
  .resize(640)
  .toFile(path.join(root, 'qa/social-640.png'));
const fmt = n =>
  `00:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000`;
await writeFile(
  path.join(root, 'video/captions.vtt'),
  'WEBVTT\n\n' + events.map(([a, b, c]) => `${fmt(a)} --> ${fmt(b)}\n${c}\n`).join('\n'),
);
if (process.argv.includes('--stills-only')) process.exit(0);
const encode = spawn(
  'ffmpeg',
  [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'image2pipe',
    '-framerate',
    String(FPS),
    '-i',
    'pipe:0',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    path.join(root, 'video/bassfish-preview.mp4'),
  ],
  { stdio: ['pipe', 'inherit', 'inherit'] },
);
const completion = once(encode, 'close');
encode.stdin.on('error', error => {
  console.error(error);
  process.exitCode = 1;
});
for (let i = 0; i < DURATION * FPS; i++) {
  const png = await sharp(Buffer.from(frame(i / FPS)))
    .png()
    .toBuffer();
  if (!encode.stdin.write(png)) await once(encode.stdin, 'drain');
  if (i % 180 === 0) console.log(`Rendered ${i}/${DURATION * FPS} frames`);
}
encode.stdin.end();
const [code] = await completion;
if (code !== 0) throw new Error(`FFmpeg exited ${code}`);
const readmeGif = spawn(
  'ffmpeg',
  [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'image2pipe',
    '-framerate',
    String(README_GIF_FPS),
    '-i',
    'pipe:0',
    '-filter_complex',
    `scale=${README_GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=reserve_transparent=1:stats_mode=diff[p];[b][p]paletteuse=alpha_threshold=128:dither=bayer:bayer_scale=3`,
    '-loop',
    '0',
    path.join(root, 'video/bassfish-preview.gif'),
  ],
  { stdio: ['pipe', 'inherit', 'inherit'] },
);
const readmeGifCompletion = once(readmeGif, 'close');
readmeGif.stdin.on('error', error => {
  console.error(error);
  process.exitCode = 1;
});
for (let i = 0; i < DURATION * README_GIF_FPS; i++) {
  const png = await sharp(Buffer.from(frame(i / README_GIF_FPS, true)))
    .png()
    .toBuffer();
  if (!readmeGif.stdin.write(png)) await once(readmeGif.stdin, 'drain');
}
readmeGif.stdin.end();
const [readmeGifCode] = await readmeGifCompletion;
if (readmeGifCode !== 0) throw new Error(`README GIF encoder exited ${readmeGifCode}`);
const gif = spawn(
  'ffmpeg',
  [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(GIF_START),
    '-t',
    String(GIF_DURATION),
    '-i',
    path.join(root, 'video/bassfish-preview.mp4'),
    '-filter_complex',
    `fps=12,scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
    '-loop',
    '0',
    path.join(root, 'video/chat-exchange.gif'),
  ],
  { stdio: 'inherit' },
);
const [gifCode] = await once(gif, 'close');
if (gifCode !== 0) throw new Error(`GIF encoder exited ${gifCode}`);
console.log('All Bassfish assets exported.');
