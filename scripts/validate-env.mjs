#!/usr/bin/env node
/**
 * Report which ADAM capabilities the current environment enables.
 *
 *   node scripts/validate-env.mjs            report (always exits 0)
 *   node scripts/validate-env.mjs --strict   exit 1 on blocking problems
 *
 * Reads process.env plus ./.env when present (process.env wins). Values are
 * never printed — only whether each is set.
 */
import { existsSync, readFileSync } from 'node:fs';

export function parseDotenv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

const set = (env, name) => Boolean(String(env[name] || '').trim());

/** @returns {{lines: string[], errors: string[], warnings: string[]}} */
export function assessEnv(env) {
  const lines = [];
  const errors = [];
  const warnings = [];
  const row = (ok, label, detail) =>
    lines.push(`${ok ? '✔' : '·'} ${label.padEnd(22)} ${detail}`);

  const google = set(env, 'GOOGLE_MAPS_API_KEY');
  const ion = set(env, 'CESIUM_ION_TOKEN');
  row(
    google || ion,
    'photoreal 3d',
    google
      ? 'google direct'
      : ion
        ? 'via cesium ion'
        : 'off — keyless esri/osm imagery, osm building extrusion',
  );
  row(
    set(env, 'OPENAI_API_KEY'),
    'voice analyst',
    set(env, 'OPENAI_API_KEY') ? 'openai realtime' : 'off — set OPENAI_API_KEY',
  );

  const providers = [
    ['ANTHROPIC_API_KEY', 'claude'],
    ['OPENAI_API_KEY', 'openai'],
    [
      set(env, 'GEMINI_API_KEY') ? 'GEMINI_API_KEY' : 'GOOGLE_AI_API_KEY',
      'gemini',
    ],
    ['VENICE_API_KEY', 'venice'],
    ['OPENROUTER_API_KEY', 'openrouter'],
  ].filter(([name]) => set(env, name));
  row(
    providers.length > 0,
    'shepherd',
    providers.length
      ? providers.map(([, l]) => l).join(', ')
      : 'off — set any of ANTHROPIC/OPENAI/GEMINI/VENICE/OPENROUTER key',
  );
  const vision = providers.some(([, l]) =>
    ['claude', 'openai', 'gemini'].includes(l),
  );
  row(
    vision,
    'image geolocation',
    vision ? 'available' : 'needs claude, openai or gemini',
  );
  if (!providers.length)
    warnings.push(
      'Shepherd has no AI provider key; the chat room will report it is offline.',
    );

  const token = String(env.ADAM_ACCESS_TOKEN || '').trim();
  const hosted = Boolean(
    env.VERCEL || env.VERCEL_ENV || env.NETLIFY || env.RENDER,
  );
  row(
    Boolean(token),
    'access gate',
    token
      ? `on (${token.length} chars)`
      : hosted
        ? 'OFF on a public host'
        : 'off (local)',
  );
  if (hosted && !token)
    errors.push(
      'ADAM_ACCESS_TOKEN is not set on a public host: every API route (and your provider keys) is open to anyone with the URL.',
    );
  if (token && token.length < 24)
    warnings.push(
      'ADAM_ACCESS_TOKEN is short; use at least 24 random characters (openssl rand -hex 32).',
    );

  for (const name of ['GOOGLE_MAPS_API_KEY', 'CESIUM_ION_TOKEN'])
    if (set(env, name))
      warnings.push(
        `${name} is sent to the browser by design — restrict it by HTTP referrer in its console.`,
      );
  for (const [name, value] of Object.entries(env))
    if (/^VITE_.*(KEY|TOKEN|SECRET)/.test(name) && String(value).trim())
      errors.push(
        `${name}: VITE_-prefixed secrets are bundled into the client. Rename it without VITE_.`,
      );
  return { lines, errors, warnings };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = existsSync('.env')
    ? parseDotenv(readFileSync('.env', 'utf8'))
    : {};
  const env = { ...file, ...process.env };
  const { lines, errors, warnings } = assessEnv(env);
  console.log('ADAM environment\n');
  for (const l of lines) console.log(`  ${l}`);
  for (const w of warnings) console.log(`\n  warning: ${w}`);
  for (const e of errors) console.log(`\n  ERROR: ${e}`);
  if (errors.length && process.argv.includes('--strict')) process.exit(1);
}
