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

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      isStaff INTEGER NOT NULL DEFAULT 1,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
  `);
}

initDb().then(async () => {
  // Migration: add updatedAt if it doesn't exist yet (older DBs won't have it).
  // Wrapped in try/catch since SQLite errors if the column already exists.
  try {
    await db.execute('ALTER TABLE questions ADD COLUMN updatedAt TEXT');
  } catch (e) {
    // Column already exists — safe to ignore.
  }
}).catch(console.error);

module.exports = { db, IMAGES_DIR };