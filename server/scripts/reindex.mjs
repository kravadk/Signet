#!/usr/bin/env node
/**
 * Reset Signet indexer cache cursors for a controlled backfill.
 *
 * This is intentionally a local operator script, not a public HTTP endpoint.
 * The chain remains source of truth; this only resets rebuildable SQLite cache
 * state so server/src/index.ts can replay events on next start/poll.
 */

import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.SIGNET_INDEXER_DB || join(__dirname, '..', 'forge.db');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] || fallback : fallback;
}

const moduleName = arg('--module', 'all');
const fromZero = process.argv.includes('--from-zero');
const dryRun = process.argv.includes('--dry-run');

const tables = [
  'repos', 'prs', 'reviews', 'issues', 'bounties', 'releases', 'release_links',
  'reputation', 'activity', 'apps', 'app_bounties', 'payment_requests', 'webhook_deliveries',
];

const db = new DatabaseSync(dbPath);

try {
  const cursors = db.prepare('SELECT module, tx, seq, updated_at FROM cursors ORDER BY module').all();
  const selected = moduleName === 'all' ? cursors : cursors.filter((c) => c.module === moduleName);
  console.log(JSON.stringify({ dbPath, module: moduleName, fromZero, dryRun, selected }, null, 2));

  if (dryRun) process.exit(0);

  db.exec('BEGIN');
  try {
    if (moduleName === 'all') db.prepare('DELETE FROM cursors').run();
    else db.prepare('DELETE FROM cursors WHERE module=?').run(moduleName);

    if (fromZero && moduleName === 'all') {
      for (const table of tables) db.prepare(`DELETE FROM ${table}`).run();
    } else if (fromZero) {
      console.warn('--from-zero with --module only resets that cursor; materialized rows are kept to avoid cross-table corruption.');
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  console.log(JSON.stringify({ ok: true, message: 'Restart or wait for the indexer poll loop to backfill.' }));
} finally {
  db.close();
}
