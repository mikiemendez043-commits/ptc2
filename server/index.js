const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const sharp = require('sharp');

const { db, IMAGES_DIR } = require('./db');
const { requireStaffAuth } = require('./auth');
const {
  EXAM_TYPES,
  QUALIFICATIONS,
  getRequiredItemCount,
  getRating,
  getRatingMessage
} = require('./constants');

const app = express();
const PORT = process.env.PORT || 3000;

const STAFF_USERNAME = process.env.STAFF_USERNAME || 'admin';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'admin123';
const EXAM_DURATION_MS = 60 * 60 * 1000;

app.use(express.json({ limit: '20mb' }));

// ---------------------------------------------------------------------------
// Token-based auth stored in Turso — survives server restarts
// ---------------------------------------------------------------------------
const SESSION_DURATION_MS = 1000 * 60 * 60 * 8; // 8 hours

function createSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Middleware to attach session to req (cached in memory, backed by Turso)
app.use(require('cookie-parser')());
const sessionCache = new Map(); // token -> { isStaff, expiresAt }

app.use(async (req, res, next) => {
  const token = req.cookies && req.cookies['staff_token'];
  req.sessionToken = token || null;
  req.session = {};
  if (token) {
    // Check memory cache first
    const cached = sessionCache.get(token);
    if (cached && Date.now() < cached.expiresAt) {
      req.session = { isStaff: cached.isStaff };
      return next();
    }
    // Fall back to Turso
    try {
      const now = new Date().toISOString();
      const result = await db.execute({
        sql: 'SELECT * FROM sessions WHERE token = ? AND expiresAt > ?',
        args: [token, now]
      });
      if (result.rows[0]) {
        const sess = { isStaff: Boolean(result.rows[0].isStaff), expiresAt: new Date(result.rows[0].expiresAt).getTime() };
        sessionCache.set(token, sess);
        req.session = { isStaff: sess.isStaff };
      }
    } catch (e) {}
  }
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// Config / constants
// ---------------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({ examTypes: EXAM_TYPES, qualifications: QUALIFICATIONS, examDurationMs: EXAM_DURATION_MS });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (username === STAFF_USERNAME && password === STAFF_PASSWORD) {
    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
    const createdAt = new Date().toISOString();
    await db.execute({
      sql: 'INSERT INTO sessions (token, isStaff, expiresAt, createdAt) VALUES (?, ?, ?, ?)',
      args: [token, 1, expiresAt, createdAt]
    });
    sessionCache.set(token, { isStaff: true, expiresAt: Date.now() + SESSION_DURATION_MS });
    res.cookie('staff_token', token, { httpOnly: true, maxAge: SESSION_DURATION_MS, sameSite: 'lax' });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid username or password.' });
});

app.post('/api/logout', async (req, res) => {
  if (req.sessionToken) {
    sessionCache.delete(req.sessionToken);
    try {
      await db.execute({ sql: 'DELETE FROM sessions WHERE token = ?', args: [req.sessionToken] });
    } catch (e) {}
  }
  res.clearCookie('staff_token');
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  res.json({ isStaff: Boolean(req.session && req.session.isStaff) });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function rowToQuestion(row) {
  let imageUrl = null;
  if (row.imageData) {
    // New style: base64 data URL stored directly in DB (cloud-safe)
    imageUrl = row.imageData;
  } else if (row.imagePath) {
    // Legacy: file stored locally — still serve it if the file exists
    imageUrl = `/exam-images/${row.imagePath}`;
  }
  return {
    id: row.id,
    examType: row.examType,
    questionText: row.questionText,
    imageUrl,
    choices: [
      { id: 'A', text: row.choiceA },
      { id: 'B', text: row.choiceB },
      { id: 'C', text: row.choiceC },
      { id: 'D', text: row.choiceD }
    ],
    correctChoiceId: row.correctChoiceId
  };
}

function rowToQuestionPublic(row) {
  const q = rowToQuestion(row);
  delete q.correctChoiceId;
  return q;
}

function rowToResult(row) {
  let answers = [];
  if (row.answersData) {
    try { answers = JSON.parse(row.answersData); } catch (e) {}
  }
  return {
    id: row.id,
    examType: row.examType,
    studentName: row.studentName,
    age: row.age,
    sex: row.sex,
    school: row.school,
    qualification: row.qualification,
    score: row.score,
    totalItems: row.totalItems,
    rating: row.rating,
    dateTaken: row.dateTaken,
    answers
  };
}

function buildAnswerDetails(questionRows, answers) {
  const answerMap = new Map((answers || []).map(item => [item.questionId, item.selectedChoice]));
  return questionRows.map(row => {
    const selectedChoice = answerMap.get(row.id) || null;
    return {
      questionId: row.id,
      questionText: row.questionText,
      // NOTE: image data is intentionally NOT stored here. It used to embed the full
      // base64 imageUrl for every question on every submission, which is what was
      // crashing the server's memory when staff loaded the results list. Nothing
      // client-side reads answers[].imageUrl anymore, so it's safe to omit.
      choices: [
        { id: 'A', text: row.choiceA },
        { id: 'B', text: row.choiceB },
        { id: 'C', text: row.choiceC },
        { id: 'D', text: row.choiceD }
      ],
      correctChoiceId: row.correctChoiceId,
      selectedChoice,
      isCorrect: selectedChoice === row.correctChoiceId
    };
  });
}

// Lightweight question mapper used for list views (student exam, question bank list).
// Never carries the base64 imageData in the payload — the client is instead given a
// URL to a dedicated image endpoint, so the bytes stream separately and are never
// held in the main JSON response or accumulated across multiple questions.
function rowToQuestionLite(row) {
  // The image URL is versioned with updatedAt so that whenever a question's
  // image actually changes, the URL string itself changes too. Without this,
  // browsers (and even in-memory tab caches that ignore Cache-Control) keep
  // reusing the previously loaded image bytes for the same URL.
  const version = row.updatedAt ? encodeURIComponent(row.updatedAt) : '';
  return {
    id: row.id,
    examType: row.examType,
    questionText: row.questionText,
    imageUrl: row.hasImage ? `/api/questions/${row.id}/image${version ? `?v=${version}` : ''}` : null,
    choices: [
      { id: 'A', text: row.choiceA },
      { id: 'B', text: row.choiceB },
      { id: 'C', text: row.choiceC },
      { id: 'D', text: row.choiceD }
    ],
    correctChoiceId: row.correctChoiceId
  };
}

function rowToQuestionLitePublic(row) {
  const q = rowToQuestionLite(row);
  delete q.correctChoiceId;
  return q;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

function endOfDayIso(fromDate) {
  const d = new Date(fromDate);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------
app.get('/api/questions', async (req, res) => {
  try {
    const { examType } = req.query;
    if (!EXAM_TYPES.includes(examType)) {
      return res.status(400).json({ error: 'Invalid or missing examType.' });
    }
    // Deliberately excludes imageData/imagePath from the SELECT — those columns can
    // hold large base64 strings, and pulling them for every question on every list
    // load is what was exhausting Render's 512MB memory limit. hasImage is a cheap
    // boolean computed in SQL so the client still knows whether to request an image.
    const result = await db.execute({
      sql: `SELECT id, examType, questionText, choiceA, choiceB, choiceC, choiceD, correctChoiceId, createdAt, updatedAt,
              CASE WHEN imageData IS NOT NULL OR imagePath IS NOT NULL THEN 1 ELSE 0 END AS hasImage
            FROM questions WHERE examType = ? ORDER BY createdAt ASC`,
      args: [examType]
    });
    const includeAnswers = Boolean(req.session && req.session.isStaff);
    res.json(result.rows.map(includeAnswers ? rowToQuestionLite : rowToQuestionLitePublic));
  } catch (error) {
    console.error('Failed to get questions:', error);
    res.status(500).json({ error: 'Failed to load questions.' });
  }
});

// Serves a single question's image on demand. This is the endpoint referenced by
// the imageUrl the list route now returns, instead of embedding base64 directly.
app.get('/api/questions/:id/image', async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT imageData, imagePath FROM questions WHERE id = ?',
      args: [req.params.id]
    });
    const row = result.rows[0];
    if (!row) return res.status(404).end();

    if (row.imageData) {
      const match = /^data:([^;]+);base64,(.+)$/.exec(row.imageData);
      if (!match) return res.status(404).end();
      const [, mimeType, base64Payload] = match;
      const buffer = Buffer.from(base64Payload, 'base64');
      res.set('Content-Type', mimeType);
      res.set('Cache-Control', 'no-cache');
      return res.send(buffer);
    }
    if (row.imagePath) {
      return res.redirect(`/exam-images/${row.imagePath}`);
    }
    return res.status(404).end();
  } catch (error) {
    console.error('Failed to serve question image:', error);
    res.status(500).end();
  }
});

app.post('/api/questions', requireStaffAuth, upload.single('image'), async (req, res) => {
  try {
    const { examType, questionText, choiceA, choiceB, choiceC, choiceD, correctChoiceId, existingImagePath, removeImage } = req.body;

    if (!EXAM_TYPES.includes(examType)) return res.status(400).json({ error: 'Invalid examType.' });
    if (!questionText || !choiceA || !choiceB || !choiceC || !choiceD) {
      return res.status(400).json({ error: 'Question text and all four choices are required.' });
    }
    if (!['A', 'B', 'C', 'D'].includes(correctChoiceId)) {
      return res.status(400).json({ error: 'A valid correct answer must be selected.' });
    }

    let imageData = null;
    let imagePath = null;
    if (req.file) {
      const resized = await sharp(req.file.buffer).resize({ width: 800, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
      const b64 = resized.toString('base64');
      imageData = `data:image/jpeg;base64,${b64}`;
    } else if (existingImagePath && removeImage !== 'true') {
      imagePath = existingImagePath;
    }

    const id = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO questions (id, examType, questionText, imagePath, imageData, choiceA, choiceB, choiceC, choiceD, correctChoiceId, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, examType, questionText.trim(), imagePath, imageData, choiceA.trim(), choiceB.trim(), choiceC.trim(), choiceD.trim(), correctChoiceId, nowIso, nowIso]
    });

    const row = await db.execute({ sql: 'SELECT * FROM questions WHERE id = ?', args: [id] });
    res.status(201).json(rowToQuestion(row.rows[0]));
  } catch (error) {
    console.error('Failed to create question:', error);
    res.status(500).json({ error: 'Failed to save question.' });
  }
});

app.put('/api/questions/:id', requireStaffAuth, upload.single('image'), async (req, res) => {
  try {
    const existingResult = await db.execute({ sql: 'SELECT * FROM questions WHERE id = ?', args: [req.params.id] });
    const existing = existingResult.rows[0];
    if (!existing) return res.status(404).json({ error: 'Question not found.' });

    const { questionText, choiceA, choiceB, choiceC, choiceD, correctChoiceId, removeImage } = req.body;
    if (!questionText || !choiceA || !choiceB || !choiceC || !choiceD) {
      return res.status(400).json({ error: 'Question text and all four choices are required.' });
    }
    if (!['A', 'B', 'C', 'D'].includes(correctChoiceId)) {
      return res.status(400).json({ error: 'A valid correct answer must be selected.' });
    }

    let imageData = existing.imageData || null;
    let imagePath = existing.imagePath || null;
    if (req.file) {
      const resized = await sharp(req.file.buffer).resize({ width: 800, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
      const b64 = resized.toString('base64');
      imageData = `data:image/jpeg;base64,${b64}`;
      imagePath = null; // new upload replaces any legacy path
    } else if (removeImage === 'true') {
      imageData = null;
      imagePath = null;
    }

    await db.execute({
      sql: `UPDATE questions SET questionText = ?, imagePath = ?, imageData = ?, choiceA = ?, choiceB = ?, choiceC = ?, choiceD = ?, correctChoiceId = ?, updatedAt = ? WHERE id = ?`,
      args: [questionText.trim(), imagePath, imageData, choiceA.trim(), choiceB.trim(), choiceC.trim(), choiceD.trim(), correctChoiceId, new Date().toISOString(), req.params.id]
    });

    const row = await db.execute({ sql: 'SELECT * FROM questions WHERE id = ?', args: [req.params.id] });
    res.json(rowToQuestion(row.rows[0]));
  } catch (error) {
    console.error('Failed to update question:', error);
    res.status(500).json({ error: 'Failed to update question.' });
  }
});

app.delete('/api/questions/:id', requireStaffAuth, async (req, res) => {
  try {
    const existingResult = await db.execute({ sql: 'SELECT * FROM questions WHERE id = ?', args: [req.params.id] });
    const existing = existingResult.rows[0];
    if (!existing) return res.status(404).json({ error: 'Question not found.' });
    await db.execute({ sql: 'DELETE FROM questions WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to delete question:', error);
    res.status(500).json({ error: 'Failed to delete question.' });
  }
});

// ---------------------------------------------------------------------------
// Access codes
// ---------------------------------------------------------------------------
app.post('/api/access-codes', requireStaffAuth, async (req, res) => {
  try {
    const { count } = req.body || {};
    const numericCount = Number(count);
    if (!Number.isInteger(numericCount) || numericCount < 1 || numericCount > 200) {
      return res.status(400).json({ error: 'Please provide a number of codes between 1 and 200.' });
    }

    const batchId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = endOfDayIso(createdAt);
    const codes = [];

    for (let i = 0; i < numericCount; i++) {
      let code;
      let attempts = 0;
      do {
        code = generateCode();
        attempts++;
        const check = await db.execute({ sql: 'SELECT 1 FROM access_codes WHERE code = ?', args: [code] });
        if (!check.rows.length) break;
      } while (attempts < 20);

      await db.execute({
        sql: 'INSERT INTO access_codes (code, batchId, createdAt, expiresAt) VALUES (?, ?, ?, ?)',
        args: [code, batchId, createdAt, expiresAt]
      });
      codes.push(code);
    }

    res.status(201).json({ batchId, createdAt, expiresAt, codes });
  } catch (error) {
    console.error('Failed to generate access codes:', error);
    res.status(500).json({ error: 'Failed to generate access codes.' });
  }
});

app.get('/api/access-codes', requireStaffAuth, async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT batchId, createdAt, expiresAt,
        COUNT(*) as total,
        SUM(CASE WHEN usedAt IS NOT NULL THEN 1 ELSE 0 END) as used
      FROM access_codes
      GROUP BY batchId
      ORDER BY createdAt DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Failed to get access codes:', error);
    res.status(500).json({ error: 'Failed to load access codes.' });
  }
});

app.get('/api/access-codes/:batchId', requireStaffAuth, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT code, usedAt, usedByResultId FROM access_codes WHERE batchId = ? ORDER BY code ASC',
      args: [req.params.batchId]
    });
    if (!result.rows.length) return res.status(404).json({ error: 'Batch not found.' });
    res.json({ batchId: req.params.batchId, codes: result.rows });
  } catch (error) {
    console.error('Failed to get batch:', error);
    res.status(500).json({ error: 'Failed to load batch.' });
  }
});

app.delete('/api/access-codes/:batchId', requireStaffAuth, async (req, res) => {
  try {
    const { batchId } = req.params;
    const check = await db.execute({ sql: 'SELECT COUNT(*) as total FROM access_codes WHERE batchId = ?', args: [batchId] });
    if (!check.rows[0] || check.rows[0].total === 0) return res.status(404).json({ error: 'Batch not found.' });
    const result = await db.execute({ sql: 'DELETE FROM access_codes WHERE batchId = ? AND usedAt IS NULL', args: [batchId] });
    res.json({ deleted: result.rowsAffected, batchId });
  } catch (error) {
    console.error('Failed to delete batch:', error);
    res.status(500).json({ error: 'Failed to delete batch.' });
  }
});

app.post('/api/access-codes/redeem', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Please enter an access code.' });
    }
    const normalizedCode = code.trim().toUpperCase();

    const rowResult = await db.execute({ sql: 'SELECT * FROM access_codes WHERE code = ?', args: [normalizedCode] });
    const row = rowResult.rows[0];
    if (!row) return res.status(404).json({ error: 'That access code was not recognized. Check with your proctor.' });
    if (row.usedAt) return res.status(409).json({ error: 'That access code has already been used.' });
    if (new Date(row.expiresAt).getTime() < Date.now()) return res.status(410).json({ error: 'That access code has expired. Ask your proctor for a new one.' });

    const redemptionToken = crypto.randomUUID();
    const examStartedAt = new Date().toISOString();

    const result = await db.execute({
      sql: 'UPDATE access_codes SET usedAt = ?, usedByResultId = ?, examStartedAt = ? WHERE code = ? AND usedAt IS NULL',
      args: [examStartedAt, redemptionToken, examStartedAt, normalizedCode]
    });

    if (result.rowsAffected === 0) {
      return res.status(409).json({ error: 'That access code has already been used.' });
    }

    res.json({
      ok: true,
      redemptionToken,
      examStartedAt,
      examDeadline: new Date(Date.parse(examStartedAt) + EXAM_DURATION_MS).toISOString()
    });
  } catch (error) {
    console.error('Failed to redeem access code:', error);
    res.status(500).json({ error: 'Failed to validate access code. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Exam submission
// ---------------------------------------------------------------------------
app.post('/api/exams/:examType/submit', async (req, res) => {
  try {
    const { examType } = req.params;
    if (!EXAM_TYPES.includes(examType)) return res.status(400).json({ error: 'Invalid exam type.' });

    const { studentName, age, sex, qualification, answers, redemptionToken } = req.body || {};
    if (!studentName || !age || !sex || !qualification || !Array.isArray(answers)) {
      return res.status(400).json({ error: 'Missing required student information or answers.' });
    }
    if (!redemptionToken || typeof redemptionToken !== 'string') {
      return res.status(401).json({ error: 'Missing access code authorization. Please restart and enter your access code.' });
    }

    const numericAge = Number(age);
    if (!Number.isFinite(numericAge) || numericAge < 10 || numericAge > 80) {
      return res.status(400).json({ error: 'Age must be between 10 and 80.' });
    }
    if (answers.length > 200) return res.status(400).json({ error: 'Too many answers submitted.' });
    if (typeof studentName !== 'string' || studentName.trim().length > 200) {
      return res.status(400).json({ error: 'Student name is invalid or too long.' });
    }
    if (!['Male', 'Female'].includes(sex)) return res.status(400).json({ error: 'Invalid sex value.' });
    if (!QUALIFICATIONS.includes(qualification)) return res.status(400).json({ error: 'Invalid qualification.' });

    const normalizedName = studentName.trim().toLowerCase();
    const normalizedQualification = qualification.trim().toLowerCase();

    // These three reads don't depend on each other, so run them concurrently
    // instead of one-after-another. Each round trip to Turso has real network
    // cost — doing this cuts submission latency roughly to a third.
    const [codeResult, alreadyTaken, questionRows] = await Promise.all([
      db.execute({ sql: 'SELECT * FROM access_codes WHERE usedByResultId = ?', args: [redemptionToken] }),
      db.execute({
        sql: 'SELECT id FROM results WHERE examType = ? AND studentNameNormalized = ? AND qualificationNormalized = ?',
        args: [examType, normalizedName, normalizedQualification]
      }),
      db.execute({ sql: 'SELECT id, questionText, choiceA, choiceB, choiceC, choiceD, correctChoiceId FROM questions WHERE examType = ?', args: [examType] })
    ]);

    if (!codeResult.rows[0]) {
      return res.status(401).json({ error: 'Your access code authorization is invalid. Please restart and enter your access code.' });
    }
    if (alreadyTaken.rows[0]) {
      return res.status(409).json({ error: `You have already completed the ${examType} exam. Only one attempt is allowed per exam.` });
    }
    if (!questionRows.rows.length) return res.status(400).json({ error: 'This exam has no questions yet.' });

    const answerDetails = buildAnswerDetails(questionRows.rows, answers);
    const score = answerDetails.filter(item => item.isCorrect).length;
    const rating = getRating(examType, score);
    const id = crypto.randomUUID();
    const dateTaken = new Date().toISOString();

    try {
      await db.execute({
        sql: `INSERT INTO results (id, examType, studentName, studentNameNormalized, age, sex, school, qualification, qualificationNormalized, score, totalItems, rating, dateTaken, answersData)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, examType, studentName.trim(), normalizedName, numericAge, sex, 'PTC-Catanduanes', qualification, normalizedQualification, score, questionRows.rows.length, rating, dateTaken, JSON.stringify(answerDetails)]
      });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `You have already completed the ${examType} exam. Only one attempt is allowed per exam.` });
      }
      throw error;
    }

    res.status(201).json({ score, totalItems: questionRows.rows.length, rating, message: getRatingMessage(rating) });
  } catch (error) {
    console.error('Failed to submit exam:', error);
    res.status(500).json({ error: 'Failed to save your exam result. Please try again.' });
  }
});

app.get('/api/exams/:examType/check-attempt', async (req, res) => {
  try {
    const { examType } = req.params;
    const { studentName, qualification } = req.query;
    if (!studentName || !qualification) return res.json({ alreadyTaken: false });
    const row = await db.execute({
      sql: 'SELECT id FROM results WHERE examType = ? AND studentNameNormalized = ? AND qualificationNormalized = ?',
      args: [examType, studentName.trim().toLowerCase(), qualification.trim().toLowerCase()]
    });
    res.json({ alreadyTaken: Boolean(row.rows[0]) });
  } catch (error) {
    res.json({ alreadyTaken: false });
  }
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
app.get('/api/results', requireStaffAuth, async (req, res) => {
  try {
    const { examType } = req.query;
    if (!EXAM_TYPES.includes(examType)) return res.status(400).json({ error: 'Invalid examType.' });
    const result = await db.execute({
      sql: 'SELECT * FROM results WHERE examType = ? ORDER BY dateTaken DESC',
      args: [examType]
    });
    res.json(result.rows.map(rowToResult));
  } catch (error) {
    console.error('Failed to get results:', error);
    res.status(500).json({ error: 'Failed to load results.' });
  }
});

app.get('/api/results/:id', requireStaffAuth, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM results WHERE id = ?', args: [req.params.id] });
    if (!result.rows[0]) return res.status(404).json({ error: 'Result not found.' });
    res.json(rowToResult(result.rows[0]));
  } catch (error) {
    console.error('Failed to get result:', error);
    res.status(500).json({ error: 'Failed to load result.' });
  }
});

app.put('/api/results/:id', requireStaffAuth, async (req, res) => {
  try {
    const existingResult = await db.execute({ sql: 'SELECT * FROM results WHERE id = ?', args: [req.params.id] });
    const existing = existingResult.rows[0];
    if (!existing) return res.status(404).json({ error: 'Result not found.' });

    const { studentName, age, sex, qualification, answers } = req.body || {};
    if (!studentName || !age || !sex || !qualification || !Array.isArray(answers)) {
      return res.status(400).json({ error: 'Missing required student information or answers.' });
    }

    const numericAge = Number(age);
    if (!Number.isFinite(numericAge) || numericAge < 10 || numericAge > 80) {
      return res.status(400).json({ error: 'Age must be between 10 and 80.' });
    }
    if (typeof studentName !== 'string' || studentName.trim().length > 200) {
      return res.status(400).json({ error: 'Student name is invalid or too long.' });
    }
    if (!['Male', 'Female'].includes(sex)) return res.status(400).json({ error: 'Invalid sex value.' });
    if (!QUALIFICATIONS.includes(qualification)) return res.status(400).json({ error: 'Invalid qualification.' });

    const normalizedName = studentName.trim().toLowerCase();
    const normalizedQualification = qualification.trim().toLowerCase();

    const duplicate = await db.execute({
      sql: 'SELECT id FROM results WHERE examType = ? AND studentNameNormalized = ? AND qualificationNormalized = ? AND id != ?',
      args: [existing.examType, normalizedName, normalizedQualification, req.params.id]
    });
    if (duplicate.rows[0]) {
      return res.status(409).json({ error: 'Another result already exists for this student and qualification.' });
    }

    const questionRows = await db.execute({ sql: 'SELECT id, questionText, choiceA, choiceB, choiceC, choiceD, correctChoiceId FROM questions WHERE examType = ?', args: [existing.examType] });
    if (!questionRows.rows.length) return res.status(400).json({ error: 'This exam has no questions yet.' });

    const answerDetails = buildAnswerDetails(questionRows.rows, answers);
    const score = answerDetails.filter(item => item.isCorrect).length;
    const rating = getRating(existing.examType, score);

    await db.execute({
      sql: `UPDATE results SET studentName = ?, studentNameNormalized = ?, age = ?, sex = ?, qualification = ?, qualificationNormalized = ?, score = ?, totalItems = ?, rating = ?, answersData = ? WHERE id = ?`,
      args: [studentName.trim(), normalizedName, numericAge, sex, qualification, normalizedQualification, score, questionRows.rows.length, rating, JSON.stringify(answerDetails), req.params.id]
    });

    const updated = await db.execute({ sql: 'SELECT * FROM results WHERE id = ?', args: [req.params.id] });
    res.json(rowToResult(updated.rows[0]));
  } catch (error) {
    console.error('Failed to update result:', error);
    res.status(500).json({ error: 'Failed to update result.' });
  }
});

app.delete('/api/results/:id', requireStaffAuth, async (req, res) => {
  try {
    const existing = await db.execute({ sql: 'SELECT * FROM results WHERE id = ?', args: [req.params.id] });
    if (!existing.rows[0]) return res.status(404).json({ error: 'Result not found.' });
    await db.execute({ sql: 'DELETE FROM results WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to delete result:', error);
    res.status(500).json({ error: 'Failed to delete result.' });
  }
});

// ---------------------------------------------------------------------------
// Dashboard summary
// ---------------------------------------------------------------------------
app.get('/api/dashboard-summary', requireStaffAuth, async (req, res) => {
  try {
    const summary = await Promise.all(EXAM_TYPES.map(async (examType) => {
      const qResult = await db.execute({ sql: 'SELECT COUNT(*) as c FROM questions WHERE examType = ?', args: [examType] });
      const rResult = await db.execute({ sql: 'SELECT COUNT(*) as c FROM results WHERE examType = ?', args: [examType] });
      return {
        examType,
        questionCount: qResult.rows[0].c,
        requiredCount: getRequiredItemCount(examType),
        attemptCount: rResult.rows[0].c
      };
    }));
    res.json(summary);
  } catch (error) {
    console.error('Failed to get dashboard summary:', error);
    res.status(500).json({ error: 'Failed to load dashboard summary.' });
  }
});

// Monthly exam-taker summary, broken down by exam type and sex. Defaults to
// the current real-world month/year whenever no query params are given, so
// it always reflects "this month" automatically as time passes — no
// hardcoded date anywhere. Counting is done entirely in SQL (GROUP BY), so
// this stays cheap and memory-safe no matter how many results accumulate;
// it never loads full result rows into the server.
app.get('/api/dashboard-summary/period', requireStaffAuth, async (req, res) => {
  try {
    const now = new Date();
    const month = req.query.month !== undefined ? parseInt(req.query.month, 10) : now.getMonth();
    const year = req.query.year !== undefined ? parseInt(req.query.year, 10) : now.getFullYear();

    if (!Number.isInteger(month) || month < 0 || month > 11 || !Number.isInteger(year)) {
      return res.status(400).json({ error: 'Invalid month or year.' });
    }

    const startOfMonth = new Date(year, month, 1).toISOString();
    const startOfNextMonth = new Date(month === 11 ? year + 1 : year, month === 11 ? 0 : month + 1, 1).toISOString();

    const result = await db.execute({
      sql: `SELECT examType, sex, COUNT(*) as cnt
            FROM results
            WHERE dateTaken >= ? AND dateTaken < ?
            GROUP BY examType, sex`,
      args: [startOfMonth, startOfNextMonth]
    });

    const breakdown = {};
    EXAM_TYPES.forEach(type => { breakdown[type] = { total: 0, male: 0, female: 0 }; });

    let grandTotal = 0;
    let grandMale = 0;
    let grandFemale = 0;

    result.rows.forEach(row => {
      const type = row.examType;
      if (!breakdown[type]) breakdown[type] = { total: 0, male: 0, female: 0 };
      const cnt = Number(row.cnt) || 0;
      breakdown[type].total += cnt;
      grandTotal += cnt;
      const sexKey = String(row.sex || '').toLowerCase();
      if (sexKey === 'male') {
        breakdown[type].male += cnt;
        grandMale += cnt;
      } else if (sexKey === 'female') {
        breakdown[type].female += cnt;
        grandFemale += cnt;
      }
    });

    res.json({ month, year, breakdown, grandTotal, grandMale, grandFemale });
  } catch (error) {
    console.error('Failed to get monthly summary:', error);
    res.status(500).json({ error: 'Failed to load monthly summary.' });
  }
});

// All-time summary of how many unique students have attempted each
// qualification, and how many of those have completed all three exam types
// vs are still partway through. Computed via a single GROUP BY query — no
// full row loads, consistent with the memory-safety fix applied earlier.
app.get('/api/dashboard-summary/qualifications', requireStaffAuth, async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT qualification, studentNameNormalized, COUNT(DISTINCT examType) as examsTaken
      FROM results
      GROUP BY qualification, studentNameNormalized
    `);

    const byQualification = {};
    QUALIFICATIONS.forEach(q => { byQualification[q] = { totalStudents: 0, completedAll: 0, inProgress: 0 }; });

    result.rows.forEach(row => {
      const qualification = row.qualification;
      if (!byQualification[qualification]) {
        byQualification[qualification] = { totalStudents: 0, completedAll: 0, inProgress: 0 };
      }
      byQualification[qualification].totalStudents += 1;
      if (Number(row.examsTaken) >= EXAM_TYPES.length) {
        byQualification[qualification].completedAll += 1;
      } else {
        byQualification[qualification].inProgress += 1;
      }
    });

    res.json({
      qualifications: QUALIFICATIONS.map(q => ({ qualification: q, ...byQualification[q] }))
    });
  } catch (error) {
    console.error('Failed to get qualification summary:', error);
    res.status(500).json({ error: 'Failed to load qualification summary.' });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, () => {
  console.log(`PTC-Catanduanes Exam System running at http://localhost:${PORT}`);
});