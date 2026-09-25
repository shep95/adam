#!/usr/bin/env node
/**
 * Apply a brand image (the ADAM sheep) as favicon, logo and social card.
 *
 *   npm run brand -- path/to/sheep.jpg
 *
 * Writes public/brand/{favicon-32.png, apple-touch-icon.png, icon-512.png,
 * logo.png, og-image.png} with sharp, then points index.html and the logo
 * templates at them. Re-running with a new image replaces the set. The
 * original vector logo stays in public/logo.svg as the fallback.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OG_BG = '#060A0C';
const ACCENT = '#00BCD4';

/** Point index.html at the brand set (idempotent). */
export function patchIndexHtml(html) {
  let out = html.replace(
    /\s*<link rel="icon"[^>]*>|\s*<link rel="apple-touch-icon"[^>]*>|\s*<meta property="og:image"[^>]*>|\s*<meta name="twitter:(card|image)"[^>]*>/g,
    '',
  );
  const tags = [
    '<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png" />',
    '<link rel="icon" type="image/png" sizes="512x512" href="/brand/icon-512.png" />',
    '<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" />',
    '<meta property="og:image" content="/brand/og-image.png" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    '<meta name="twitter:image" content="/brand/og-image.png" />',
  ];
  out = out.replace(/(<head[^>]*>)/i, `$1\n  ${tags.join('\n  ')}`);
  return out;
}

/** Point a logo template at the raster logo (logoGaze falls back to <img>). */
export function patchLogoTemplate(html) {
  return html
    .replaceAll('data-logo-src="/logo.svg"', 'data-logo-src="/brand/logo.png"')
    .replaceAll('<img src="/logo.svg"', '<img src="/brand/logo.png"');
}

async function main() {
  const input = process.argv[2];
  if (!input || !existsSync(input)) {
    console.error('usage: npm run brand -- path/to/image.(jpg|png|webp)');
    process.exit(1);
  }
  const { default: sharp } = await import('sharp');
  const out = path.resolve('public/brand');
  mkdirSync(out, { recursive: true });
  const square = (size) =>
    sharp(input).resize(size, size, { fit: 'cover', position: 'attention' });
  const circle = (size) =>
    Buffer.from(
      `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
    );
  await square(32).png().toFile(path.join(out, 'favicon-32.png'));
  await square(180).png().toFile(path.join(out, 'apple-touch-icon.png'));
  await square(512).png().toFile(path.join(out, 'icon-512.png'));
  await square(256)
    .composite([{ input: circle(256), blend: 'dest-in' }])
    .png()
    .toFile(path.join(out, 'logo.png'));
  const art = await square(470)
    .composite([{ input: circle(470), blend: 'dest-in' }])
    .png()
    .toBuffer();
  const text = Buffer.from(
    `<svg width="1200" height="630"><style>.t{font:600 88px 'IBM Plex Mono',monospace;fill:#E6F4F6;letter-spacing:18px}.s{font:400 30px 'IBM Plex Mono',monospace;fill:${ACCENT};letter-spacing:6px}</style><text x="610" y="300" class="t">ADAM</text><text x="614" y="360" class="s">#HOUSEOFASHER</text><rect x="614" y="392" width="360" height="2" fill="${ACCENT}" opacity="0.6"/></svg>`,
  );
  await sharp({
    create: { width: 1200, height: 630, channels: 4, background: OG_BG },
  })
    .composite([
      { input: art, left: 80, top: 80 },
      { input: text, left: 0, top: 0 },
    ])
    .png()
    .toFile(path.join(out, 'og-image.png'));

  writeFileSync(
    'index.html',
    patchIndexHtml(readFileSync('index.html', 'utf8')),
  );
  for (const file of [
    'src/ui/templates/scene-chrome.html',
    'src/ui/templates/hud-loading.html',
  ])
    if (existsSync(file))
      writeFileSync(file, patchLogoTemplate(readFileSync(file, 'utf8')));
  console.log('brand applied: public/brand/* and index.html');
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
