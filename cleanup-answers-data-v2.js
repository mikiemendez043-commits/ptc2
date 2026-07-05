// One-time cleanup script (v2) — does the cleanup entirely inside Turso using
// SQLite's JSON functions, so the large answersData blobs never have to be
// downloaded to this machine and re-uploaded. Only small summary numbers
// (lengths) cross the network. This avoids the "socket terminated" issue
// that happens when trying to pull a multi-megabyte row over HTTP.
//
// Usage (same as before):
//   set TURSO_URL=libsql://your-db-url-here
//   set TURSO_TOKEN=your-token-here
//   node cleanup-answers-data-v2.js

const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

async function main() {
  if (!process.env.TURSO_URL || !process.env.TURSO_TOKEN) {
    console.error('Missing TURSO_URL or TURSO_TOKEN environment variables. Set them first.');
    process.exit(1);
  }

  console.log('Checking current sizes (bytes) of answersData per result...');
  const before = await db.execute('SELECT id, length(answersData) as len FROM results');
  before.rows.forEach(r => console.log(`  ${r.id}: ${r.len} bytes`));

  console.log('');
  console.log('Running cleanup entirely inside Turso (this may take a little while for large rows, but nothing large crosses the network)...');

  await db.execute(`
    UPDATE results
    SET answersData = (
      SELECT json_group_array(json_remove(value, '$.imageUrl'))
      FROM json_each(answersData)
    )
    WHERE answersData IS NOT NULL
  `);

  console.log('Cleanup statement completed.');
  console.log('');
  console.log('Checking sizes after cleanup...');
  const after = await db.execute('SELECT id, length(answersData) as len FROM results');
  after.rows.forEach(r => console.log(`  ${r.id}: ${r.len} bytes`));

  console.log('');
  console.log('Done.');
}

main().catch(err => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
