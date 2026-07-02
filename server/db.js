const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

const DATA_DIR = path.join(__dirname, '..', 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

async function initDb() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      examType TEXT NOT NULL,
      questionText TEXT NOT NULL,
      imagePath TEXT,
      imageData TEXT,
      choiceA TEXT NOT NULL,
      choiceB TEXT NOT NULL,
      choiceC TEXT NOT NULL,
      choiceD TEXT NOT NULL,
      correctChoiceId TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS results (
      id TEXT PRIMARY KEY,
      examType TEXT NOT NULL,
      studentName TEXT NOT NULL,
      studentNameNormalized TEXT NOT NULL,
      age INTEGER NOT NULL,
      sex TEXT NOT NULL,
      school TEXT NOT NULL,
      qualification TEXT NOT NULL,
      qualificationNormalized TEXT NOT NULL,
      score INTEGER NOT NULL,
      totalItems INTEGER NOT NULL,
      rating TEXT NOT NULL,
      dateTaken TEXT NOT NULL,
      answersData TEXT
    );

    CREATE TABLE IF NOT EXISTS access_codes (
      code TEXT PRIMARY KEY,
      batchId TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      usedAt TEXT,
      usedByResultId TEXT,
      examStartedAt TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_questions_examType ON questions(examType);
    CREATE INDEX IF NOT EXISTS idx_results_examType ON results(examType);
    CREATE INDEX IF NOT EXISTS idx_access_codes_batchId ON access_codes(batchId);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_results_unique_attempt
      ON results(examType, studentNameNormalized, qualificationNormalized);
  `);
}

initDb().catch(console.error);

// Migration: add imageData column if it doesn't exist yet (for existing deployments)
async function migrateDb() {
  try {
    const cols = await db.execute("SELECT name FROM pragma_table_info('questions')");
    const hasImageData = cols.rows.some(r => r.name === 'imageData');
    if (!hasImageData) {
      await db.execute('ALTER TABLE questions ADD COLUMN imageData TEXT');
      console.log('Migration: added imageData column to questions table.');
    }
  } catch (e) {
    // pragma_table_info not available on all libsql versions — ignore if migration check fails
    console.warn('Migration check skipped:', e.message);
  }
}
migrateDb().catch(console.error);

module.exports = { db, IMAGES_DIR };