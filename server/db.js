const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'exam.db');
const IMAGES_DIR = path.join(DATA_DIR, 'images');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;'); // better for concurrent reads/writes across many users

db.exec(`
  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    examType TEXT NOT NULL,
    questionText TEXT NOT NULL,
    imagePath TEXT,
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

const resultColumns = db.prepare("SELECT name FROM pragma_table_info('results')").all();
if (!resultColumns.some(column => column.name === 'answersData')) {
  db.exec('ALTER TABLE results ADD COLUMN answersData TEXT');
}

const accessCodeColumns = db.prepare("SELECT name FROM pragma_table_info('access_codes')").all();
if (accessCodeColumns.length && !accessCodeColumns.some(column => column.name === 'examStartedAt')) {
  db.exec('ALTER TABLE access_codes ADD COLUMN examStartedAt TEXT');
}

module.exports = { db, IMAGES_DIR };