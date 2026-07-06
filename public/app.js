// ---------------------------------------------------------------------------
// API client - all data now lives on the server, not in localStorage.
// ---------------------------------------------------------------------------
const api = {
  async getConfig() {
    const res = await fetch('/api/config');
    return res.json();
  },
  async getSession() {
    const res = await fetch('/api/session');
    return res.json();
  },
  async login(username, password) {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed.');
    return data;
  },
  async logout() {
    await fetch('/api/logout', { method: 'POST' });
  },
  async getQuestions(examType) {
    const res = await fetch(`/api/questions?examType=${encodeURIComponent(examType)}`);
    if (!res.ok) throw new Error('Failed to load questions.');
    return res.json();
  },
  async saveQuestion(formData, questionId) {
    const url = questionId ? `/api/questions/${questionId}` : '/api/questions';
    const method = questionId ? 'PUT' : 'POST';
    const res = await fetch(url, { method, body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save question.');
    return data;
  },
  async deleteQuestion(questionId) {
    const res = await fetch(`/api/questions/${questionId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete question.');
    return data;
  },
  async submitExam(examType, payload) {
    const res = await fetch(`/api/exams/${examType}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to submit exam.');
    return data;
  },
  async checkAttempt(examType, studentName, qualification) {
    const params = new URLSearchParams({ studentName, qualification });
    const res = await fetch(`/api/exams/${examType}/check-attempt?${params}`);
    return res.json();
  },
  async getResults(examType) {
    const res = await fetch(`/api/results?examType=${encodeURIComponent(examType)}`);
    if (!res.ok) throw new Error('Failed to load results.');
    return res.json();
  },
  async deleteResult(resultId) {
    const res = await fetch(`/api/results/${resultId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete result.');
    return data;
  },
  async getDashboardSummary() {
    const res = await fetch('/api/dashboard-summary');
    if (!res.ok) throw new Error('Failed to load dashboard summary.');
    return res.json();
  },
  async getMonthlySummary(month, year) {
    const params = new URLSearchParams();
    if (month !== undefined && month !== null) params.set('month', month);
    if (year !== undefined && year !== null) params.set('year', year);
    const query = params.toString();
    const res = await fetch(`/api/dashboard-summary/period${query ? `?${query}` : ''}`);
    if (!res.ok) throw new Error('Failed to load monthly summary.');
    return res.json();
  },
  async getQualificationSummary() {
    const res = await fetch('/api/dashboard-summary/qualifications');
    if (!res.ok) throw new Error('Failed to load qualification summary.');
    return res.json();
  },
  async getQualificationDetail(qualification) {
    const res = await fetch(`/api/dashboard-summary/qualifications/${encodeURIComponent(qualification)}`);
    if (!res.ok) throw new Error('Failed to load qualification detail.');
    return res.json();
  },
  async generateAccessCodes(count) {
    const res = await fetch('/api/access-codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to generate access codes.');
    return data;
  },
  async getAccessCodeBatches() {
    const res = await fetch('/api/access-codes');
    if (!res.ok) throw new Error('Failed to load access code batches.');
    return res.json();
  },
  async deleteAccessCodeBatch(batchId) {
    const res = await fetch(`/api/access-codes/${batchId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete batch.');
    return data;
  },
  async getAccessCodeBatch(batchId) {
    const res = await fetch(`/api/access-codes/${batchId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load batch details.');
    return data;
  },
  async redeemAccessCode(code) {
    const res = await fetch('/api/access-codes/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to validate access code.');
    return data;
  }
};

function formatDateLocal(isoString) {
  try {
    const date = new Date(isoString);
    return date.toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric'
    });
  } catch {
    return isoString;
  }
}

function getQueryParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

function getRatingMessage(rating) {
  switch (rating) {
    case 'Excellent':
      return 'Outstanding work. You demonstrated strong subject mastery.';
    case 'Very Good':
      return 'Great performance. Keep studying and you will continue to improve.';
    case 'Good':
      return 'A solid score. Review a few areas and come back even stronger.';
    case 'Fair':
      return 'A fair attempt. Practice more to build confidence and knowledge.';
    case 'Poor':
      return 'A challenging result. Focus on fundamentals and try again after more practice.';
    case 'Very Poor':
      return 'This exam was difficult. Seek review materials and ask your instructor for help.';
    default:
      return 'Your exam is complete. Review the results and reach out if you need support.';
  }
}

function getPeriodFilter(results, mode) {
  const now = new Date();
  if (mode === 'year') {
    return results.filter(result => {
      const taken = new Date(result.dateTaken);
      return taken.getFullYear() === now.getFullYear();
    });
  }
  if (mode === 'month') {
    return results.filter(result => {
      const taken = new Date(result.dateTaken);
      return taken.getFullYear() === now.getFullYear() && taken.getMonth() === now.getMonth();
    });
  }
  return results;
}

function getPeriodLabel(mode) {
  const now = new Date();
  if (mode === 'year') {
    return `${now.getFullYear()}`;
  }
  const monthName = now.toLocaleString(undefined, { month: 'long' });
  return `${monthName} ${now.getFullYear()}`;
}

function getMostCommonRating(results) {
  if (!results.length) return null;
  const tally = results.reduce((acc, item) => {
    acc[item.rating] = (acc[item.rating] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(tally).sort((a, b) => b[1] - a[1])[0] || null;
}

function getRatingCounts(results) {
  const ratingOrder = ['Very Poor', 'Poor', 'Fair', 'Good', 'Very Good', 'Excellent'];
  return ratingOrder.map(label => ({ label, count: results.filter(item => item.rating === label).length }));
}

function drawRatingPieChart(canvas, results) {
  const ctx = canvas.getContext('2d');
  const counts = getRatingCounts(results);
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!total) {
    ctx.fillStyle = '#64748b';
    ctx.font = '16px Inter, system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('No submissions', canvas.width / 2, canvas.height / 2);
    return;
  }
  const colors = ['#a4a6ff', '#f97316', '#fbbf24', '#22c55e', '#38bdf8', '#16a34a'];
  let startAngle = -0.5 * Math.PI;
  counts.forEach((item, index) => {
    if (!item.count) return;
    const sliceAngle = (item.count / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(canvas.width / 2, canvas.height / 2);
    ctx.arc(canvas.width / 2, canvas.height / 2, Math.min(canvas.width, canvas.height) / 2 - 20, startAngle, startAngle + sliceAngle);
    ctx.closePath();
    ctx.fillStyle = colors[index];
    ctx.fill();
    startAngle += sliceAngle;
  });
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  startAngle = -0.5 * Math.PI;
  counts.forEach(item => {
    if (!item.count) return;
    const sliceAngle = (item.count / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2, Math.min(canvas.width, canvas.height) / 2 - 20, startAngle, startAngle + sliceAngle);
    ctx.stroke();
    startAngle += sliceAngle;
  });
}

function downloadCSV(filename, rows) {
  const header = ['School', 'Qualification', 'Name', 'Age', 'Sex', 'Score', 'Rating', 'Date Taken'];
  const escapedRows = [header.join(',')].concat(rows.map(row =>
    [row.school, row.qualification, row.studentName, row.age, row.sex, `${row.score}/${row.totalItems}`, row.rating, formatDateLocal(row.dateTaken)]
      .map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')
  ));
  const csv = escapedRows.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Redirects to staff-login.html if there's no active staff session.
// Call this at the top of any staff-only page.
async function requireStaffSession() {
  const { isStaff } = await api.getSession();
  if (!isStaff) {
    window.location.href = 'staff-login.html';
    return false;
  }
  return true;
}
// ---------------------------------------------------------------------------
// Shared staff navigation bar. Call renderStaffNav('dashboard' | 'questions' |
// 'results' | 'codes') near the top of a staff page's init to inject it.
// Centralized here so every page stays in sync without duplicating markup.
// ---------------------------------------------------------------------------
function renderStaffNav(activeKey) {
  const navLinks = [
    { key: 'dashboard', label: 'Dashboard', href: 'staff-dashboard.html' },
    { key: 'questions', label: 'Question Bank', href: 'staff-exam-builder.html' },
    { key: 'codes', label: 'Access Codes', href: 'staff-access-codes.html' },
  ];

  const nav = document.createElement('nav');
  nav.className = 'staff-nav';
  nav.innerHTML = `
    <div class="staff-nav-inner">
      <a class="staff-nav-brand" href="staff-dashboard.html">PTC-Catanduanes</a>
      <div class="staff-nav-links">
        ${navLinks.map(link => `
          <a class="staff-nav-link ${link.key === activeKey ? 'active' : ''}" href="${link.href}">${link.label}</a>
        `).join('')}
      </div>
      <button class="button button-secondary staff-nav-logout" id="staffNavLogout" type="button">Logout</button>
    </div>
  `;
  document.body.insertBefore(nav, document.body.firstChild);

  document.getElementById('staffNavLogout').addEventListener('click', async () => {
    showSpinner('Logging out...');
    await api.logout();
    window.location.href = 'staff-login.html';
  });
}


(function() {
  const overlay = document.createElement('div');
  overlay.className = 'spinner-overlay';
  overlay.id = 'globalSpinner';
  overlay.innerHTML = '<div class="spinner-ring"></div><span class="spinner-label" id="spinnerLabel">Loading...</span>';
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(overlay));
})();

function showSpinner(label = 'Loading...') {
  const overlay = document.getElementById('globalSpinner');
  const labelEl = document.getElementById('spinnerLabel');
  if (overlay) { overlay.classList.add('active'); }
  if (labelEl) { labelEl.textContent = label; }
}

function hideSpinner() {
  const overlay = document.getElementById('globalSpinner');
  if (overlay) overlay.classList.remove('active');
}

function setButtonLoading(btn, loading, originalText) {
  if (!btn) return;
  if (loading) {
    btn.dataset.originalText = btn.textContent;
    btn.classList.add('loading');
    btn.disabled = true;
    if (originalText) btn.textContent = originalText;
  } else {
    btn.classList.remove('loading');
    btn.disabled = false;
    btn.textContent = btn.dataset.originalText || btn.textContent;
  }
}