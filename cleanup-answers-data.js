// One-time cleanup script.
// Strips the old embedded base64 "imageUrl" field out of every stored
// results.answersData row in Turso. Older code used to save the full
// base64 image string for every question on every exam submission — this
// script removes that bloat from data that's already saved, without ever
// holding more than one result's worth of data in memory at a time.
//
// Run this ONCE, locally (not on Render), after deploying the index.js fix.
//
// Usage (from your project root, in cmd.exe):
//   set TURSO_URL=libsql://your-db-url-here
//   set TURSO_TOKEN=your-token-here
//   node cleanup-answers-data.js

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

  console.log('Fetching result IDs...');
  const idsResult = await db.execute('SELECT id FROM results');
  const ids = idsResult.rows.map(r => r.id);
  console.log(`Found ${ids.length} result(s) to check.`);

  let cleaned = 0;
  let skipped = 0;
  let bytesRemoved = 0;

  for (const id of ids) {
    const rowResult = await db.execute({
      sql: 'SELECT answersData FROM results WHERE id = ?',
      args: [id]
    });
    const row = rowResult.rows[0];
    if (!row || !row.answersData) {
      skipped++;
      continue;
    }

    const originalLength = row.answersData.length;
    let answers;
    try {
      answers = JSON.parse(row.answersData);
    } catch (e) {
      console.warn(`  Skipping ${id}: could not parse answersData JSON.`);
      skipped++;
      continue;
    }

    if (!Array.isArray(answers)) {
      skipped++;
      continue;
    }

    const hadImageUrl = answers.some(a => a && Object.prototype.hasOwnProperty.call(a, 'imageUrl'));
    if (!hadImageUrl) {
      skipped++;
      continue;
    }

    const cleanedAnswers = answers.map(a => {
      if (!a || typeof a !== 'object') return a;
      const { imageUrl, ...rest } = a;
      return rest;
    });

    const newJson = JSON.stringify(cleanedAnswers);
    bytesRemoved += (originalLength - newJson.length);

    await db.execute({
      sql: 'UPDATE results SET answersData = ? WHERE id = ?',
      args: [newJson, id]
    });

    cleaned++;
    console.log(`  Cleaned ${id}: ${originalLength} -> ${newJson.length} bytes`);
  }

  console.log('---');
  console.log(`Done. Cleaned: ${cleaned}, skipped (already clean or empty): ${skipped}`);
  console.log(`Approximate bytes removed: ${(bytesRemoved / 1024 / 1024).toFixed(2)} MB`);
}

main().catch(err => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
