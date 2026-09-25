import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findBrandSource,
  patchIndexHtml,
  patchLogoTemplate,
} from '../../scripts/brand.mjs';

test('index.html patch swaps the icon and adds the social card, idempotently', () => {
  const html =
    '<html><head>\n  <meta charset="utf-8" />\n  <link rel="icon" type="image/svg+xml" href="/logo.svg" />\n</head></html>';
  const once = patchIndexHtml(html);
  assert.ok(!once.includes('/logo.svg'));
  assert.match(once, /href="\/brand\/favicon-32\.png"/);
  assert.match(once, /og:image" content="\/brand\/og-image\.png"/);
  assert.equal(patchIndexHtml(once), once);
});

test('logo templates point at the raster logo', () => {
  const t =
    '<span data-logo-src="/logo.svg"><img src="/logo.svg" alt="" /></span>';
  assert.equal(
    patchLogoTemplate(t),
    '<span data-logo-src="/brand/logo.png"><img src="/brand/logo.png" alt="" /></span>',
  );
});

test('the vector sheep mark is also swapped for the photo, and the photo is found', () => {
  assert.equal(
    patchLogoTemplate('<img src="/brand/sheep-mark.svg" alt="" />'),
    '<img src="/brand/logo.png" alt="" />',
  );
  assert.equal(
    findBrandSource((p) => p === 'brand/sheep.jpg'),
    'brand/sheep.jpg',
  );
  assert.equal(
    findBrandSource(() => false),
    null,
  );
});
