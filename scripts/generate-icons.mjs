/**
 * Draws the app icons from one vector source.
 *
 * Generated rather than committed as binaries so the mark can be changed in one
 * place: a PWA needs 192, 512, a maskable 512 and an Apple 180, and four exported
 * PNGs from an editor drift apart the first time anyone edits only one of them.
 *
 *   node scripts/generate-icons.mjs
 *
 * Output goes to `public/icons/`, which Vite copies verbatim into `dist` and the
 * Capacitor builds bundle as-is.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const OUT = join('public', 'icons');

/** Deep field green with a cream wheat ear: readable at 48 px, no fine hairlines. */
const MARK = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="112" fill="#1F2A17"/>
  <g fill="none" stroke="#EDE7D3" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">
    <path d="M256 392V200"/>
    <path d="M256 232c-46 0-74-24-80-62 40-6 72 10 80 62z" fill="#EDE7D3" stroke="none"/>
    <path d="M256 232c46 0 74-24 80-62-40-6-72 10-80 62z" fill="#EDE7D3" stroke="none"/>
    <path d="M256 300c-40 0-64-20-70-52 34-4 62 10 70 52z" fill="#D9D2B8" stroke="none"/>
    <path d="M256 300c40 0 64-20 70-52-34-4-62 10-70 52z" fill="#D9D2B8" stroke="none"/>
  </g>
  <circle cx="256" cy="176" r="16" fill="#EDE7D3"/>
</svg>`;

/** A maskable icon is cropped to a circle on Android, so the mark shrinks inside the safe zone. */
const MASKABLE = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="#1F2A17"/>
  <g transform="translate(256 256) scale(0.72) translate(-256 -256)">
    <g fill="none" stroke="#EDE7D3" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">
      <path d="M256 392V200"/>
      <path d="M256 232c-46 0-74-24-80-62 40-6 72 10 80 62z" fill="#EDE7D3" stroke="none"/>
      <path d="M256 232c46 0 74-24 80-62-40-6-72 10-80 62z" fill="#EDE7D3" stroke="none"/>
      <path d="M256 300c-40 0-64-20-70-52 34-4 62 10 70 52z" fill="#D9D2B8" stroke="none"/>
      <path d="M256 300c40 0 64-20 70-52-34-4-62 10-70 52z" fill="#D9D2B8" stroke="none"/>
    </g>
    <circle cx="256" cy="176" r="16" fill="#EDE7D3"/>
  </g>
</svg>`;

async function png(svg, size, file) {
  await sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toFile(join(OUT, file));
  return file;
}

await mkdir(OUT, { recursive: true });

const written = [
  await png(MARK, 192, 'icon-192.png'),
  await png(MARK, 512, 'icon-512.png'),
  await png(MASKABLE, 512, 'icon-maskable-512.png'),
  /* iOS ignores the manifest's icons and reads this exact size from the page. */
  await png(MASKABLE, 180, 'apple-touch-icon.png'),
];

await writeFile(join(OUT, 'mark.svg'), MARK.trim(), 'utf8');
written.push('mark.svg');

console.log(`generate-icons: wrote ${written.length} files to ${OUT}`);
