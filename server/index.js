const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

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

// ---- Staff credentials ----
// Demo-only credentials, same as before. Change these before real deployment.
// For anything beyond a single shared login, swap this for a proper user table + hashed passwords.
const STAFF_USERNAME = process.env.STAFF_USERNAME || 'admin';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'admin123';
const EXAM_DURATION_MS = 60 * 60 * 1000; // 1 hour, fixed for all exams

app.use(express.json({ limit: '2mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-before-deploying',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 8 // 8 hour staff session
  }
}));

// ---- Image upload handling ----
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, IMAGES_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      cb(null, `${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per image
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  }
});

app.use('/exam-images', express.static(IMAGES_DIR));
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
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === STAFF_USERNAME && password === STAFF_PASSWORD) {
    req.session.isStaff = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid username or password.' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ isStaff: Boolean(req.session && req.session.isStaff) });
});

// ---------------------------------------------------------------------------
// Questions (public read for students taking exams; write requires staff)
// ---------------------------------------------------------------------------
function rowToQuestion(row) {
  return {
    id: row.id,
    examType: row.examType,
    questionText: row.questionText,
    imageUrl: row.imagePath ? `/exam-images/${row.imagePath}` : null,
    choices: [
      { id: 'A', text: row.choiceA },
      { id: 'B', text: row.choiceB },
      { id: 'C', text: row.choiceC },
      { id: 'D', text: row.choiceD }
    ],
    correctChoiceId: row.correctChoiceId
  };
}

// Returns questions WITHOUT correct answers - safe for students mid-exam.
function rowToQuestionPublic(row) {
  const q = rowToQuestion(row);
  delete q.correctChoiceId;
  return q;
}

app.get('/api/questions', (req, res) => {
  const { examType } = req.query;
  if (!EXAM_TYPES.includes(examType)) {
    return res.status(400).json({ error: 'Invalid or missing examType.' });
  }
  const rows = db.prepare('SELECT * FROM questions WHERE examType = ? ORDER BY createdAt ASC').all(examType);
  const includeAnswers = Boolean(req.session && req.session.isStaff);
  res.json(rows.map(includeAnswers ? rowToQuestion : rowToQuestionPublic));
});

app.post('/api/questions', requireStaffAuth, upload.single('image'), (req, res) => {
  try {
    const { examType, questionText, choiceA, choiceB, choiceC, choiceD, correctChoiceId, existingImagePath, removeImage } = req.body;

    if (!EXAM_TYPES.includes(examType)) return res.status(400).json({ error: 'Invalid examType.' });
    if (!questionText || !choiceA || !choiceB || !choiceC || !choiceD) {
      return res.status(400).json({ error: 'Question text and all four choices are required.' });
    }
    if (questionText.length > 2000 || [choiceA, choiceB, choiceC, choiceD].some(c => c.length > 500)) {
      return res.status(400).json({ error: 'Question text or choice text is too long.' });
    }
    if (!['A', 'B', 'C', 'D'].includes(correctChoiceId)) {
      return res.status(400).json({ error: 'A valid correct answer must be selected.' });
    }

    let imagePath = null;
    if (req.file) {
      imagePath = req.file.filename;
    } else if (existingImagePath && removeImage !== 'true') {
      imagePath = existingImagePath;
    }

    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO questions (id, examType, questionText, imagePath, choiceA, choiceB, choiceC, choiceD, correctChoiceId, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, examType, questionText.trim(), imagePath, choiceA.trim(), choiceB.trim(), choiceC.trim(), choiceD.trim(), correctChoiceId, new Date().toISOString());

    const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
    res.status(201).json(rowToQuestion(row));
  } catch (error) {
    console.error('Failed to create question:', error);
    res.status(500).json({ error: 'Failed to save question.' });
  }
});

app.put('/api/questions/:id', requireStaffAuth, upload.single('image'), (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Question not found.' });

    const { questionText, choiceA, choiceB, choiceC, choiceD, correctChoiceId, removeImage } = req.body;
    if (!questionText || !choiceA || !choiceB || !choiceC || !choiceD) {
      return res.status(400).json({ error: 'Question text and all four choices are required.' });
    }
    if (!['A', 'B', 'C', 'D'].includes(correctChoiceId)) {
      return res.status(400).json({ error: 'A valid correct answer must be selected.' });
    }

    let imagePath = existing.imagePath;
    if (req.file) {
      if (existing.imagePath) {
        const oldPath = path.join(IMAGES_DIR, existing.imagePath);
        fs.unlink(oldPath, () => {}); // best-effort cleanup, ignore errors
      }
      imagePath = req.file.filename;
    } else if (removeImage === 'true') {
      if (existing.imagePath) {
        const oldPath = path.join(IMAGES_DIR, existing.imagePath);
        fs.unlink(oldPath, () => {});
      }
      imagePath = null;
    }

    db.prepare(`
      UPDATE questions
      SET questionText = ?, imagePath = ?, choiceA = ?, choiceB = ?, choiceC = ?, choiceD = ?, correctChoiceId = ?
      WHERE id = ?
    `).run(questionText.trim(), imagePath, choiceA.trim(), choiceB.trim(), choiceC.trim(), choiceD.trim(), correctChoiceId, req.params.id);

    const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
    res.json(rowToQuestion(row));
  } catch (error) {
    console.error('Failed to update question:', error);
    res.status(500).json({ error: 'Failed to update question.' });
  }
});

app.delete('/api/questions/:id', requireStaffAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Question not found.' });
  if (existing.imagePath) {
    fs.unlink(path.join(IMAGES_DIR, existing.imagePath), () => {});
  }
  db.prepare('DELETE FROM questions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

function buildAnswerDetails(questionRows, answers) {
  const answerMap = new Map((answers || []).map(item => [item.questionId, item.selectedChoice]));
  return questionRows.map(row => {
    const selectedChoice = answerMap.get(row.id) || null;
    return {
      questionId: row.id,
      questionText: row.questionText,
      imageUrl: row.imagePath ? `/exam-images/${row.imagePath}` : null,
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

function rowToResult(row) {
  let answers = [];
  if (row.answersData) {
    try {
      answers = JSON.parse(row.answersData);
    } catch (error) {
      console.error('Failed to parse result answers:', error);
    }
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

// ---------------------------------------------------------------------------
// Access codes (staff generates batches; students redeem one to unlock an exam)
// ---------------------------------------------------------------------------
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
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

app.post('/api/access-codes', requireStaffAuth, (req, res) => {
  const { count } = req.body || {};
  const numericCount = Number(count);
  if (!Number.isInteger(numericCount) || numericCount < 1 || numericCount > 200) {
    return res.status(400).json({ error: 'Please provide a number of codes between 1 and 200.' });
  }

  const batchId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = endOfDayIso(createdAt);
  const codes = [];

  const insert = db.prepare(`
    INSERT INTO access_codes (code, batchId, createdAt, expiresAt)
    VALUES (?, ?, ?, ?)
  `);

  for (let i = 0; i < numericCount; i++) {
    let code;
    let attempts = 0;
    // Regenerate on the rare collision with an existing unexpired code.
    do {
      code = generateCode();
      attempts++;
    } while (db.prepare('SELECT 1 FROM access_codes WHERE code = ?').get(code) && attempts < 20);
    insert.run(code, batchId, createdAt, expiresAt);
    codes.push(code);
  }

  res.status(201).json({ batchId, createdAt, expiresAt, codes });
});

app.get('/api/access-codes', requireStaffAuth, (req, res) => {
  const batches = db.prepare(`
    SELECT batchId, createdAt, expiresAt,
      COUNT(*) as total,
      SUM(CASE WHEN usedAt IS NOT NULL THEN 1 ELSE 0 END) as used
    FROM access_codes
    GROUP BY batchId
    ORDER BY createdAt DESC
  `).all();
  res.json(batches);
});

app.get('/api/access-codes/:batchId', requireStaffAuth, (req, res) => {
  const codes = db.prepare(`
    SELECT code, usedAt, usedByResultId FROM access_codes WHERE batchId = ? ORDER BY code ASC
  `).all(req.params.batchId);
  if (!codes.length) return res.status(404).json({ error: 'Batch not found.' });
  res.json({ batchId: req.params.batchId, codes });
});

app.delete('/api/access-codes/:batchId', requireStaffAuth, (req, res) => {
  const { batchId } = req.params;
  const batch = db.prepare('SELECT COUNT(*) as total FROM access_codes WHERE batchId = ?').get(batchId);
  if (!batch || batch.total === 0) return res.status(404).json({ error: 'Batch not found.' });
  // Only delete unused codes — used codes are kept as an audit trail.
  const result = db.prepare('DELETE FROM access_codes WHERE batchId = ? AND usedAt IS NULL').run(batchId);
  res.json({ deleted: result.changes, batchId });
});

// Validates and immediately burns a code, so it cannot be reused even if the
// exam that follows is never finished. Students call this before starting an exam.
app.post('/api/access-codes/redeem', (req, res) => {
  const { code } = req.body || {};
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Please enter an access code.' });
  }
  const normalizedCode = code.trim().toUpperCase();

  const row = db.prepare('SELECT * FROM access_codes WHERE code = ?').get(normalizedCode);
  if (!row) {
    return res.status(404).json({ error: 'That access code was not recognized. Check with your proctor.' });
  }
  if (row.usedAt) {
    return res.status(409).json({ error: 'That access code has already been used.' });
  }
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    return res.status(410).json({ error: 'That access code has expired. Ask your proctor for a new one.' });
  }

  const redemptionToken = crypto.randomUUID();
  const examStartedAt = new Date().toISOString();
  try {
    const result = db.prepare(`
      UPDATE access_codes SET usedAt = ?, usedByResultId = ?, examStartedAt = ?
      WHERE code = ? AND usedAt IS NULL
    `).run(examStartedAt, redemptionToken, examStartedAt, normalizedCode);
    if (result.changes === 0) {
      // Lost a race with a simultaneous redemption attempt for the same code.
      return res.status(409).json({ error: 'That access code has already been used.' });
    }
  } catch (error) {
    console.error('Failed to redeem access code:', error);
    return res.status(500).json({ error: 'Failed to validate access code. Please try again.' });
  }

  res.json({
    ok: true,
    redemptionToken,
    examStartedAt,
    examDeadline: new Date(Date.parse(examStartedAt) + EXAM_DURATION_MS).toISOString()
  });
});

// ---------------------------------------------------------------------------
// Exam submission (student-facing)
// ---------------------------------------------------------------------------
app.post('/api/exams/:examType/submit', (req, res) => {
  const { examType } = req.params;
  if (!EXAM_TYPES.includes(examType)) return res.status(400).json({ error: 'Invalid exam type.' });

  const { studentName, age, sex, qualification, answers, redemptionToken } = req.body || {};
  if (!studentName || !age || !sex || !qualification || !Array.isArray(answers)) {
    return res.status(400).json({ error: 'Missing required student information or answers.' });
  }
  if (!redemptionToken || typeof redemptionToken !== 'string') {
    return res.status(401).json({ error: 'Missing access code authorization. Please restart and enter your access code.' });
  }
  const codeRow = db.prepare('SELECT * FROM access_codes WHERE usedByResultId = ?').get(redemptionToken);
  if (!codeRow) {
    return res.status(401).json({ error: 'Your access code authorization is invalid. Please restart and enter your access code.' });
  }
  if (typeof studentName !== 'string' || studentName.trim().length > 200) {
    return res.status(400).json({ error: 'Student name is invalid or too long.' });
  }
  if (!['Male', 'Female'].includes(sex)) {
    return res.status(400).json({ error: 'Invalid sex value.' });
  }
  if (!QUALIFICATIONS.includes(qualification)) {
    return res.status(400).json({ error: 'Invalid qualification.' });
  }
  const numericAge = Number(age);
  if (!Number.isFinite(numericAge) || numericAge < 10 || numericAge > 80) {
    return res.status(400).json({ error: 'Age must be between 10 and 80.' });
  }
  if (answers.length > 200) {
    return res.status(400).json({ error: 'Too many answers submitted.' });
  }

  const normalizedName = studentName.trim().toLowerCase();
  const normalizedQualification = qualification.trim().toLowerCase();

  const alreadyTaken = db.prepare(`
    SELECT id FROM results WHERE examType = ? AND studentNameNormalized = ? AND qualificationNormalized = ?
  `).get(examType, normalizedName, normalizedQualification);
  if (alreadyTaken) {
    return res.status(409).json({ error: `You have already completed the ${examType} exam. Only one attempt is allowed per exam.` });
  }

  // Score server-side using the real correct answers - never trust the client's score.
  const questionRows = db.prepare('SELECT * FROM questions WHERE examType = ?').all(examType);
  if (!questionRows.length) {
    return res.status(400).json({ error: 'This exam has no questions yet.' });
  }
  const answerDetails = buildAnswerDetails(questionRows, answers);
  const score = answerDetails.filter(item => item.isCorrect).length;
  const rating = getRating(examType, score);
  const id = crypto.randomUUID();
  const dateTaken = new Date().toISOString();

  try {
    db.prepare(`
      INSERT INTO results (id, examType, studentName, studentNameNormalized, age, sex, school, qualification, qualificationNormalized, score, totalItems, rating, dateTaken, answersData)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, examType, studentName.trim(), normalizedName, numericAge, sex, 'PTC-Catanduanes', qualification, normalizedQualification, score, questionRows.length, rating, dateTaken, JSON.stringify(answerDetails));
  } catch (error) {
    // Race condition: two simultaneous submissions for the same student. The unique index catches it.
    if (String(error.message).includes('UNIQUE')) {
      return res.status(409).json({ error: `You have already completed the ${examType} exam. Only one attempt is allowed per exam.` });
    }
    console.error('Failed to save result:', error);
    return res.status(500).json({ error: 'Failed to save your exam result. Please try again.' });
  }

  res.status(201).json({
    score,
    totalItems: questionRows.length,
    rating,
    message: getRatingMessage(rating)
  });
});

app.get('/api/exams/:examType/check-attempt', (req, res) => {
  const { examType } = req.params;
  const { studentName, qualification } = req.query;
  if (!studentName || !qualification) return res.json({ alreadyTaken: false });
  const row = db.prepare(`
    SELECT id FROM results WHERE examType = ? AND studentNameNormalized = ? AND qualificationNormalized = ?
  `).get(examType, studentName.trim().toLowerCase(), qualification.trim().toLowerCase());
  res.json({ alreadyTaken: Boolean(row) });
});

// ---------------------------------------------------------------------------
// Results (staff only)
// ---------------------------------------------------------------------------
app.get('/api/results', requireStaffAuth, (req, res) => {
  const { examType } = req.query;
  if (!EXAM_TYPES.includes(examType)) return res.status(400).json({ error: 'Invalid examType.' });
  const rows = db.prepare('SELECT * FROM results WHERE examType = ? ORDER BY dateTaken DESC').all(examType);
  res.json(rows.map(rowToResult));
});

app.get('/api/results/:id', requireStaffAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM results WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Result not found.' });
  res.json(rowToResult(row));
});

app.put('/api/results/:id', requireStaffAuth, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM results WHERE id = ?').get(req.params.id);
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
    if (!['Male', 'Female'].includes(sex)) {
      return res.status(400).json({ error: 'Invalid sex value.' });
    }
    if (!QUALIFICATIONS.includes(qualification)) {
      return res.status(400).json({ error: 'Invalid qualification.' });
    }

    const normalizedName = studentName.trim().toLowerCase();
    const normalizedQualification = qualification.trim().toLowerCase();

    const duplicate = db.prepare(`
      SELECT id FROM results
      WHERE examType = ? AND studentNameNormalized = ? AND qualificationNormalized = ? AND id != ?
    `).get(existing.examType, normalizedName, normalizedQualification, req.params.id);
    if (duplicate) {
      return res.status(409).json({ error: 'Another result already exists for this student and qualification.' });
    }

    const questionRows = db.prepare('SELECT * FROM questions WHERE examType = ?').all(existing.examType);
    if (!questionRows.length) {
      return res.status(400).json({ error: 'This exam has no questions yet.' });
    }

    const answerDetails = buildAnswerDetails(questionRows, answers);
    const score = answerDetails.filter(item => item.isCorrect).length;
    const rating = getRating(existing.examType, score);

    db.prepare(`
      UPDATE results
      SET studentName = ?, studentNameNormalized = ?, age = ?, sex = ?, qualification = ?, qualificationNormalized = ?, score = ?, totalItems = ?, rating = ?, answersData = ?
      WHERE id = ?
    `).run(studentName.trim(), normalizedName, numericAge, sex, qualification, normalizedQualification, score, questionRows.length, rating, JSON.stringify(answerDetails), req.params.id);

    const updated = db.prepare('SELECT * FROM results WHERE id = ?').get(req.params.id);
    res.json(rowToResult(updated));
  } catch (error) {
    console.error('Failed to update result:', error);
    res.status(500).json({ error: 'Failed to update result.' });
  }
});

app.delete('/api/results/:id', requireStaffAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM results WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Result not found.' });
  db.prepare('DELETE FROM results WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/dashboard-summary', requireStaffAuth, (req, res) => {
  const summary = EXAM_TYPES.map(examType => {
    const questionCount = db.prepare('SELECT COUNT(*) as c FROM questions WHERE examType = ?').get(examType).c;
    const attemptCount = db.prepare('SELECT COUNT(*) as c FROM results WHERE examType = ?').get(examType).c;
    return {
      examType,
      questionCount,
      requiredCount: getRequiredItemCount(examType),
      attemptCount
    };
  });
  res.json(summary);
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