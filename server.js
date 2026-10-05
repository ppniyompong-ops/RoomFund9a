const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1); // behind Render's proxy, so req.ip is the real client
const PORT = process.env.PORT || 3000;
const FEE = 50;
const DEFAULT_PIN = '1234';
const MONTHS = ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'payments.json');

// ---- Students: "number studentId gender firstName lastName"
const RAW = `
1 39797 F Poonnisa Boonta
2 39926 F Thanasukan Chaikiti
3
4 40126 F Pisitta Thanawiriya
5 40130 F Kanchanat Yangruay
6 40132 M Cholatee Phattharaudomkit
7 40135 M Nithi Suriyakanont
8 40138 F Aroonrung Duangjai
9 40140 M Thanapat Kimhunsawat
10 40172 F Chomphoopear Thewarakphitak
11 40211 M Xiangting Ge
12 40219 F Yixuan Li
13 40221 M Kaden Singto
14 40228 M Phongsaphak Chatho
15 40229 M Patcharawat Saengsawang
16 40230 M Ratikorn Jindamath
17 40232 F Nichapa Aksornvanich
18 40298 M Nititorn Chaisri
19 40316 F Punnachat Sompawong
20 
21 40334 M Pat Wisadsing
22 
23 40347 F Porntip Rattanawaorachot
24 40370 M Nathan Andre Madjus Hotti
25 40128 F Kanokrat Radchusiri
26 40402 M Shiwen Zou
27 40426 M Zhengquan Zhao
28 41188 M Truman Kam
29 41225 M Bailin Lu
30 41226 M Yunsong Jiang
31 41948 F Namo Yaemvathithong
`;
const STUDENTS = RAW.trim().split('\n').filter((l) => l.trim().split(/\s+/).length >= 5).map((l) => {
  const [n, sid, g, first, last] = l.trim().split(/\s+/);
  return { id: +n, number: +n, studentId: +sid, name: `${first} ${last}` };
});

// ---- Staff (default password: PASS_<USERNAME> env, else STAFF_PASSWORD env, else 'pichayut').
// Once someone changes a password in the dashboard, the stored (hashed) one is used instead.
const STAFF = {
  Admin001: { name: 'Admin 01', role: 'admin' },
  Admin002: { name: 'Admin 02', role: 'admin' },
};
const defaultPassword = (u) => process.env['PASS_' + u.toUpperCase()] || process.env.STAFF_PASSWORD || 'pichayut';

// ---- Persistent store: PostgreSQL when DATABASE_URL is set (survives restarts), otherwise a JSON file
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }, max: 3 });
  pool.on('error', (e) => console.error('db pool error:', e.message));
}
let payments = {}, withdrawals = [], incomes = [], passwords = {}, pins = {}, audit = [];
const loadFrom = (j) => {
  if (j && j.payments) {
    payments = j.payments; withdrawals = j.withdrawals || []; incomes = j.incomes || []; passwords = j.passwords || {}; pins = j.pins || {}; audit = j.audit || [];
  } else payments = j || {};
};
// In PostgreSQL mode, slip / receipt images are stored once each in a separate `blobs` table
// (content-addressed by SHA-256). The main row then only holds small metadata, so saving
// after every change does not rewrite megabytes of images.
const blobId = (str) => crypto.createHash('sha256').update(str).digest('hex');
const savedBlobs = new Set();
function splitBlobs() {
  const blobs = new Map(), pay = {};
  for (const [sid, ms] of Object.entries(payments)) {
    pay[sid] = {};
    for (const [m, p] of Object.entries(ms)) {
      if (p.slip) {
        p.hash = p.hash || blobId(p.slip);
        blobs.set(p.hash, p.slip);
        const { slip, ...rest } = p;
        pay[sid][m] = { ...rest, slipRef: p.hash };
      } else pay[sid][m] = p;
    }
  }
  const wds = withdrawals.map((w) => {
    if (!w.receipt) return w;
    w.receiptHash = w.receiptHash || blobId(w.receipt);
    blobs.set(w.receiptHash, w.receipt);
    const { receipt, ...rest } = w;
    return { ...rest, receiptRef: w.receiptHash };
  });
  return { pay, wds, blobs };
}
async function init() {
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb NOT NULL)');
    await pool.query('CREATE TABLE IF NOT EXISTS blobs (id text PRIMARY KEY, data text NOT NULL)');
    const r = await pool.query("SELECT v FROM kv WHERE k = 'main'");
    if (r.rows[0]) {
      const j = r.rows[0].v;
      const b = await pool.query('SELECT id, data FROM blobs');
      const map = new Map(b.rows.map((x) => [x.id, x.data]));
      map.forEach((_, id) => savedBlobs.add(id));
      for (const ms of Object.values(j.payments || {})) for (const p of Object.values(ms)) {
        if (p.slipRef) { p.slip = map.get(p.slipRef); delete p.slipRef; if (!p.slip) delete p.slip; }
      }
      for (const w of j.withdrawals || []) {
        if (w.receiptRef) { w.receipt = map.get(w.receiptRef); delete w.receiptRef; if (!w.receipt) delete w.receipt; }
      }
      loadFrom(j);
    }
    console.log('storage: PostgreSQL');
  } else {
    try { loadFrom(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) { /* first run */ }
    console.log('storage: file ' + DATA_FILE);
  }
}
let saveChain = Promise.resolve();
const save = () => {
  if (pool) {
    const { pay, wds, blobs } = splitBlobs();
    const snapshot = JSON.stringify({ payments: pay, withdrawals: wds, incomes, passwords, pins, audit });
    const fresh = [...blobs].filter(([id]) => !savedBlobs.has(id)), keep = [...blobs.keys()];
    saveChain = saveChain.then(async () => {
      for (const [id, data] of fresh) {
        await pool.query('INSERT INTO blobs (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, data]);
        savedBlobs.add(id);
      }
      await pool.query('INSERT INTO kv (k, v) VALUES ($1, $2::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', ['main', snapshot]);
      await pool.query('DELETE FROM blobs WHERE id <> ALL($1::text[])', [keep]);
      for (const id of [...savedBlobs]) if (!keep.includes(id)) savedBlobs.delete(id);
    }).catch((e) => console.error('db save failed:', e.message));
    return;
  }
  try { fs.writeFileSync(DATA_FILE, JSON.stringify({ payments, withdrawals, incomes, passwords, pins, audit })); } catch (e) { console.error('save failed:', e.message); }
};

// ---- Passwords (staff)
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const setPassword = (u, pw) => { const salt = crypto.randomBytes(16).toString('hex'); passwords[u] = { salt, hash: hashPw(pw, salt) }; };
const checkPassword = (u, pw) => {
  const p = passwords[u];
  if (!p) return pw === defaultPassword(u);
  const a = Buffer.from(hashPw(pw, p.salt), 'hex'), b = Buffer.from(p.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const validNewPassword = (pw) => typeof pw === 'string' && pw.length >= 6 && pw.length <= 64;

// ---- Student PINs (kept readable on purpose so admins can look them up when someone forgets)
const getPin = (id) => pins[id] || DEFAULT_PIN;
const validPin = (p) => typeof p === 'string' && /^\d{4}$/.test(p);
const thaiDigits = (v) => String(v ?? '').replace(/[๐-๙]/g, (d) => '๐๑๒๓๔๕๖๗๘๙'.indexOf(d)).replace(/\s+/g, '');

// ---- Wrong-PIN lock: 5 wrong tries per student or 30 per IP lock that key for 15 minutes
const fails = new Map();
function failState(key, max) {
  const f = fails.get(key);
  if (!f || f.reset < Date.now()) return 0;
  return f.n >= max ? Math.ceil((f.reset - Date.now()) / 60000) : 0;
}
function addFail(key) {
  const f = fails.get(key);
  if (!f || f.reset < Date.now()) fails.set(key, { n: 1, reset: Date.now() + 15 * 60e3 });
  else f.n++;
}

// ---- Dates (Thailand time, UTC+7). A month becomes payable on the 1st day of that month.
const todayStr = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const thaiDate = (iso) => new Date(new Date(iso).getTime() + 7 * 3600e3).toISOString().slice(0, 10);
const isDue = (m) => m + '-01' <= todayStr();
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
const MTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m) => `${MTH[+m.slice(5) - 1]} ${+m.slice(0, 4) + 543}`;
const ST_TH = { approved: 'Paid', unpaid: 'Unpaid', pending: 'Pending', none: '-' };

// ---- Audit log
function logAct(by, action, detail) {
  audit.push({ at: new Date().toISOString(), by, action, detail: detail || '' });
  if (audit.length > 2000) audit.splice(0, audit.length - 2000);
}

// A month with no stored record is '-' (none) until it is due, then 'unpaid'.
const rec = (sid, m) => (payments[sid] && payments[sid][m]) || { status: isDue(m) ? 'unpaid' : 'none', auto: true };
const findStudent = (id) => STUDENTS.find((s) => s.id === Number(id));
const monthView = (sid) => MONTHS.map((m) => {
  const p = rec(sid, m);
  return { month: m, amount: FEE, status: p.status, notDue: !!(p.auto && p.status === 'none'), type: p.type || null, note: p.note || null, submittedAt: p.submittedAt || null };
});
const collected = () => { let n = 0; STUDENTS.forEach((s) => MONTHS.forEach((m) => { if (rec(s.id, m).status === 'approved') n += FEE; })); return n; };
const round2 = (n) => Math.round(n * 100) / 100;
const withdrawn = () => round2(withdrawals.reduce((a, w) => a + w.amount, 0));
const incomeTotal = () => round2(incomes.reduce((a, i) => a + i.amount, 0));
const balanceNow = () => round2(collected() + incomeTotal() - withdrawn());
const sortedIncomes = () => incomes
  .map((i) => ({ id: i.id, amount: i.amount, source: i.source, by: i.by, editedAt: i.editedAt, at: i.at, date: i.date || thaiDate(i.at) }))
  .sort((a, b) => (b.date + b.at).localeCompare(a.date + a.at));
const sortedWithdrawals = () => withdrawals
  .map((w) => ({ id: w.id, amount: w.amount, reason: w.reason, by: w.by, editedAt: w.editedAt, at: w.at, date: w.date || thaiDate(w.at), hasReceipt: !!w.receipt }))
  .sort((a, b) => (b.date + b.at).localeCompare(a.date + a.at));

// ---- Duplicate slip detection: exact (SHA-256) is rejected; visually similar (dHash) is flagged for the admin
const hamming = (a, b) => { let x = BigInt('0x' + a) ^ BigInt('0x' + b), n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };
function findDupSlip(hash, ph) {
  let exact = null, similar = null;
  for (const [sid, ms] of Object.entries(payments)) for (const [m, p] of Object.entries(ms)) {
    if (p.type !== 'slip' || !['pending', 'approved'].includes(p.status)) continue;
    if (p.hash === hash) exact = { sid, m };
    else if (!similar && ph && p.ph && hamming(ph, p.ph) <= 8) similar = { sid, m };
  }
  return { exact, similar };
}
const IMG_RE = /^data:image\/(png|jpe?g|webp);base64,/;

// ---- Sessions (staff and student)
const sessions = new Map();
const TTL = 12 * 3600 * 1000;
const sessionOf = (req) => {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const s = sessions.get(t);
  if (!s || s.exp < Date.now()) { sessions.delete(t); return null; }
  return { t, s };
};
const auth = (roles) => (req, res, next) => {
  const x = sessionOf(req);
  if (!x || x.s.kind !== 'staff') return res.status(401).json({ error: 'Please log in' });
  if (roles && !roles.includes(x.s.role)) return res.status(403).json({ error: 'You do not have permission to perform this action' });
  req.user = x.s; req.token = x.t;
  next();
};
const studentAuth = (req, res, next) => {
  const x = sessionOf(req);
  if (!x || x.s.kind !== 'student') return res.status(401).json({ error: 'Please log in' });
  req.student = findStudent(x.s.studentId); req.token = x.t;
  next();
};
const dropSessions = (match, keepToken) => { for (const [t, s] of sessions) if (t !== keepToken && match(s)) sessions.delete(t); };

app.use(cors());
app.use('/api/admin/restore', express.json({ limit: '100mb' })); // backups can contain many slip images
app.use(express.json({ limit: '15mb' }));

// Pages live in /public. If the upload lost that folder (index.html / admin.html next to server.js),
// serve just those two files from the root instead (never the whole root, which holds server code + data).
const HAS_PUBLIC = fs.existsSync(path.join(__dirname, 'public', 'index.html'));
const pageFile = (name) => (HAS_PUBLIC ? path.join(__dirname, 'public', name) : path.join(__dirname, name));
const sendPage = (name) => (req, res) => res.sendFile(pageFile(name), (err) => {
  if (err) res.status(404).type('text').send(`File not found ${name} on the server. Please upload the public folder (index.html, admin.html) next to server.js`);
});
if (HAS_PUBLIC) app.use(express.static(path.join(__dirname, 'public')));
else { app.get('/index.html', sendPage('index.html')); app.get('/admin.html', sendPage('admin.html')); }

// ================= Student APIs =================
app.post('/api/student/login', (req, res) => {
  const body = req.body || {};
  const raw = thaiDigits(body.id), pin = thaiDigits(body.pin);
  if (!/^\d+$/.test(raw)) return res.status(400).json({ error: 'Please enter a 5-digit student ID' });
  if (!validPin(pin)) return res.status(400).json({ error: 'Please enter a 4-digit PIN' });
  const n = Number(raw);
  const s = raw.length === 5 ? STUDENTS.find((x) => x.studentId === n) : STUDENTS.find((x) => x.number === n);
  if (!s) return res.status(404).json({ error: 'Student not found' });
  const sKey = 's:' + s.id, ipKey = 'ip:' + req.ip;
  const lock = Math.max(failState(sKey, 5), failState(ipKey, 30));
  if (lock) return res.status(429).json({ error: `Too many incorrect attempts. Please wait ${lock} minutes before trying again` });
  if (pin !== getPin(s.id)) { addFail(sKey); addFail(ipKey); return res.status(401).json({ error: 'Incorrect PIN' }); }
  fails.delete(sKey);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { kind: 'student', studentId: s.id, exp: Date.now() + TTL });
  res.json({ token, student: s });
});

app.post('/api/student/change-pin', studentAuth, (req, res) => {
  const { oldPin, newPin } = req.body || {};
  const s = req.student;
  if (thaiDigits(oldPin) !== getPin(s.id)) return res.status(403).json({ error: 'Current PIN is incorrect' });
  if (!validPin(thaiDigits(newPin))) return res.status(400).json({ error: 'New PIN must be 4 digits' });
  pins[s.id] = thaiDigits(newPin);
  dropSessions((x) => x.kind === 'student' && x.studentId === s.id, req.token);
  logAct(`${s.name} (student)`, 'Change PIN', `No. ${s.number}`);
  save();
  res.json({ ok: true });
});

app.get('/api/student/data/:studentId', studentAuth, (req, res) => {
  const s = req.student;
  if (String(s.id) !== String(req.params.studentId)) return res.status(403).json({ error: "You cannot view another student's data" });
  const months = monthView(s.id);
  res.json({
    student: s, fee: FEE, months,
    totalUnpaid: months.filter((m) => m.status === 'unpaid').length * FEE,
    totalPending: months.filter((m) => m.status === 'pending').length * FEE,
  });
});

// Read-only room-fund summary for students
app.get('/api/student/summary', studentAuth, (req, res) => {
  res.json({
    collected: collected(), otherIncome: incomeTotal(), withdrawn: withdrawn(), balance: balanceNow(),
    incomes: sortedIncomes().map(({ id, date, amount, source }) => ({ id, date, amount, source })),
    withdrawals: sortedWithdrawals().map((w) => ({ id: w.id, date: w.date, amount: w.amount, reason: w.reason, hasReceipt: w.hasReceipt })),
  });
});

app.post('/api/student/submit-pay', studentAuth, (req, res) => {
  const { studentId, month, method, slip, ph } = req.body || {};
  const s = req.student;
  if (studentId !== undefined && Number(studentId) !== s.id) return res.status(403).json({ error: 'You cannot submit payment for another student' });
  if (!MONTHS.includes(month)) return res.status(400).json({ error: 'Invalid month' });
  const cur = rec(s.id, month);
  if (cur.status === 'none') return res.status(409).json({ error: cur.auto ? 'This month is not due yet (payment starts on the 1st)' : 'No payment is required for this month' });
  if (cur.status === 'approved') return res.status(409).json({ error: 'This month has already been paid and approved' });
  if (cur.status === 'pending') return res.status(409).json({ error: 'This month is pending review' });

  let entry;
  if (slip) {
    if (typeof slip !== 'string' || !IMG_RE.test(slip.slice(0, 40)) || slip.length > 12e6)
      return res.status(400).json({ error: 'Slip must be a PNG/JPG/WEBP image no larger than ~9MB' });
    const hash = crypto.createHash('sha256').update(slip).digest('hex');
    const phash = typeof ph === 'string' && /^[0-9a-f]{64}$/.test(ph) ? ph : null;
    const d = findDupSlip(hash, phash);
    if (d.exact) return res.status(409).json({ error: 'This slip has already been submitted. Please attach the slip for this transfer.' });
    entry = { type: 'slip', slip, hash, ph: phash };
    if (d.similar) entry.dupNote = `Similar to the slip for No. ${findStudent(d.similar.sid).number} (${monthLabel(d.similar.m)})`;
  } else if (method === 'Cash') {
    entry = { type: 'Cash' };
  } else {
    return res.status(400).json({ error: 'Please attach a slip or choose cash payment' });
  }
  payments[s.id] = payments[s.id] || {};
  payments[s.id][month] = { ...entry, status: 'pending', submittedAt: new Date().toISOString() };
  logAct(`${s.name} (student)`, 'Payment reported', `No. ${s.number} · ${monthLabel(month)} · ${entry.type === 'cash' ? 'cash' : 'bank transfer slip'}${entry.dupNote ? ' ⚠ ' + entry.dupNote : ''}`);
  save();
  res.json({ ok: true, status: 'pending' });
});

// Withdrawal receipt image: any logged-in student or staff
app.get('/api/receipt/:id', (req, res) => {
  if (!sessionOf(req)) return res.status(401).json({ error: 'Please log in' });
  const w = withdrawals.find((x) => x.id === req.params.id);
  if (!w || !w.receipt) return res.status(404).json({ error: 'Receipt not found' });
  res.json({ receipt: w.receipt });
});

// ================= Staff APIs =================
app.post('/api/staff/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Please enter username and password' });
  const u = Object.keys(STAFF).find((k) => k.toLowerCase() === String(username).toLowerCase());
  if (!u || !checkPassword(u, String(password))) return res.status(401).json({ error: 'Incorrect username or password' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { kind: 'staff', username: u, name: STAFF[u].name, role: STAFF[u].role, exp: Date.now() + TTL });
  res.json({ token, user: { username: u, name: STAFF[u].name, role: STAFF[u].role } });
});

// Change my own password (admin or teacher)
app.post('/api/staff/change-password', auth(), (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!checkPassword(req.user.username, String(oldPassword || ''))) return res.status(403).json({ error: 'Current password is incorrect' });
  if (!validNewPassword(newPassword)) return res.status(400).json({ error: 'New password must be 6-64 characters' });
  setPassword(req.user.username, newPassword);
  dropSessions((x) => x.kind === 'staff' && x.username === req.user.username, req.token);
  logAct(req.user.name, 'Changed own password', '');
  save();
  res.json({ ok: true });
});

app.get('/api/staff/overview', auth(['admin', 'teacher']), (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const c = { approved: 0, pending: 0, unpaid: 0, none: 0 };
  const pendingList = [];
  const students = STUDENTS.map((s) => {
    const months = monthView(s.id);
    months.forEach((m) => {
      c[m.status]++;
      if (m.status === 'pending') pendingList.push({ studentId: s.id, number: s.number, name: s.name, month: m.month, type: m.type, submittedAt: m.submittedAt, dupNote: rec(s.id, m.month).dupNote || null });
    });
    return { ...s, ...(isAdmin ? { pin: getPin(s.id) } : {}), months: months.map((m) => ({ month: m.month, status: m.status, note: m.note })) };
  });
  pendingList.sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)));
  res.json({
    user: { username: req.user.username, name: req.user.name, role: req.user.role },
    accounts: isAdmin ? Object.keys(STAFF).map((u) => ({ username: u, name: STAFF[u].name, role: STAFF[u].role })) : undefined,
    today: todayStr(), storage: pool ? 'database' : 'file', fee: FEE, months: MONTHS,
    stats: {
      students: STUDENTS.length, expected: (c.approved + c.pending + c.unpaid) * FEE, counts: c,
      collected: c.approved * FEE, pendingAmount: c.pending * FEE, unpaidAmount: c.unpaid * FEE,
      withdrawn: withdrawn(), otherIncome: incomeTotal(), balance: round2(c.approved * FEE + incomeTotal() - withdrawn()),
    },
    pending: pendingList, students, withdrawals: sortedWithdrawals(), incomes: sortedIncomes(), audit: audit.slice(-100).reverse(),
  });
});

app.get('/api/staff/slip/:studentId/:month', auth(['admin', 'teacher']), (req, res) => {
  const p = payments[req.params.studentId] && payments[req.params.studentId][req.params.month];
  if (!p || p.status === 'unpaid' || p.status === 'none') return res.status(404).json({ error: 'Payment record not found' });
  res.json({ type: p.type, slip: p.slip || null, link: p.link || null, status: p.status, dupNote: p.dupNote || null });
});

// ================= Admin APIs =================
app.post('/api/admin/verify', auth(['admin']), (req, res) => {
  const { studentId, month, action, reason } = req.body || {};
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action must be approve or reject' });
  if (!MONTHS.includes(month)) return res.status(400).json({ error: 'Invalid month' });
  const s = findStudent(studentId);
  if (!s) return res.status(404).json({ error: 'Student not found' });
  const p = payments[s.id] && payments[s.id][month];
  if (!p || p.status !== 'pending') return res.status(404).json({ error: 'Pending payment not found' });
  const who = `No. ${s.number} ${s.name} · ${monthLabel(month)}`;
  if (action === 'approve') {
    p.status = 'approved'; p.verifiedBy = req.user.username; p.verifiedAt = new Date().toISOString();
    logAct(req.user.name, 'Approved payment', who);
  } else {
    const note = String(reason || 'Slip failed review').slice(0, 200);
    payments[s.id][month] = { status: 'unpaid', note };
    logAct(req.user.name, 'Rejected payment', `${who} · ${note}`);
  }
  save();
  res.json({ ok: true, status: payments[s.id][month].status });
});

// Apply a status to one student-month. Returns 'ok' | 'same' | 'notdue' | 'balance'.
function applyStatus(s, month, status, username) {
  const cur = rec(s.id, month);
  if (cur.status === status) return 'same';
  if (status === 'unpaid' && !isDue(month)) return 'notdue';
  if (cur.status === 'approved' && balanceNow() - FEE < 0) return 'balance';
  payments[s.id] = payments[s.id] || {};
  if (status === 'approved') {
    const { auto, ...rest } = cur;
    payments[s.id][month] = { ...rest, status: 'approved', type: cur.type || 'manual', verifiedBy: username, verifiedAt: new Date().toISOString() };
  } else if (status === 'none') payments[s.id][month] = { status: 'none' };
  else delete payments[s.id][month];
  return 'ok';
}
const STATUS_ERR = {
  same: 'This status is already set',
  notdue: 'This month is not due yet and will become unpaid on the 1st',
  balance: 'Cannot change because the remaining balance would be less than the amount already withdrawn',
};

app.post('/api/admin/set-status', auth(['admin']), (req, res) => {
  const { studentId, month, status } = req.body || {};
  if (!['approved', 'unpaid', 'none'].includes(status)) return res.status(400).json({ error: 'status must be approved, unpaid, or none' });
  if (!MONTHS.includes(month)) return res.status(400).json({ error: 'Invalid month' });
  const s = findStudent(studentId);
  if (!s) return res.status(404).json({ error: 'Student not found' });
  const before = rec(s.id, month).status;
  const r = applyStatus(s, month, status, req.user.username);
  if (r !== 'ok') return res.status(409).json({ error: STATUS_ERR[r] });
  logAct(req.user.name, 'Change status', `No. ${s.number} ${s.name} · ${monthLabel(month)}: ${ST_TH[before]} → ${ST_TH[status]}`);
  save();
  res.json({ ok: true, status });
});

app.post('/api/admin/bulk-status', auth(['admin']), (req, res) => {
  const { studentIds, months, status } = req.body || {};
  if (!['approved', 'unpaid', 'none'].includes(status)) return res.status(400).json({ error: 'status must be approved, unpaid, or none' });
  if (!Array.isArray(studentIds) || !studentIds.length || studentIds.length > 200) return res.status(400).json({ error: 'Please select students' });
  if (!Array.isArray(months) || !months.length || months.some((m) => !MONTHS.includes(m))) return res.status(400).json({ error: 'Invalid month' });
  const list = [...new Set(studentIds.map(Number))].map(findStudent);
  if (list.some((x) => !x)) return res.status(404).json({ error: 'Some students were not found' });
  const out = { updated: 0, same: 0, blocked: 0 };
  for (const st of list) for (const m of months) {
    const r = applyStatus(st, m, status, req.user.username);
    if (r === 'ok') out.updated++; else if (r === 'same') out.same++; else out.blocked++;
  }
  if (out.updated) {
    logAct(req.user.name, 'Changed status for multiple students', `${list.length} students · ${months.length === MONTHS.length ? 'All months' : months.map(monthLabel).join(', ')} → ${ST_TH[status]} (Updated ${out.updated} item)`);
    save();
  }
  res.json({ ok: true, ...out });
});

// Reset another account's password (admin only)
app.post('/api/admin/set-password', auth(['admin']), (req, res) => {
  const { username, newPassword } = req.body || {};
  if (!Object.prototype.hasOwnProperty.call(STAFF, username)) return res.status(404).json({ error: 'Account not found' });
  if (!validNewPassword(newPassword)) return res.status(400).json({ error: 'New password must be 6-64 characters' });
  setPassword(username, newPassword);
  dropSessions((x) => x.kind === 'staff' && x.username === username, username === req.user.username ? req.token : null);
  logAct(req.user.name, 'Set a new password for', `${STAFF[username].name} (${username})`);
  save();
  res.json({ ok: true });
});

// Set / reset a student's PIN (admin only)
app.post('/api/admin/set-pin', auth(['admin']), (req, res) => {
  const { studentId, pin } = req.body || {};
  const s = findStudent(studentId);
  if (!s) return res.status(404).json({ error: 'Student not found' });
  const p = thaiDigits(pin);
  if (!validPin(p)) return res.status(400).json({ error: 'PIN must be 4 digits' });
  pins[s.id] = p;
  fails.delete('s:' + s.id);
  dropSessions((x) => x.kind === 'student' && x.studentId === s.id, null);
  logAct(req.user.name, 'Set student PIN', `No. ${s.number} ${s.name}`);
  save();
  res.json({ ok: true });
});

// ---- Backup / restore (admin)
app.get('/api/admin/backup', auth(['admin']), (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="roomfund-backup-${todayStr()}.json"`);
  res.json({ version: 2, exportedAt: new Date().toISOString(), payments, withdrawals, incomes, pins, audit });
});
function validBackup(b) {
  if (!b || typeof b.payments !== 'object' || b.payments === null || Array.isArray(b.payments) || !Array.isArray(b.withdrawals)) return false;
  for (const [sid, ms] of Object.entries(b.payments)) {
    if (!findStudent(sid) || typeof ms !== 'object' || ms === null) return false;
    for (const [m, p] of Object.entries(ms)) if (!MONTHS.includes(m) || !p || !['approved', 'pending', 'unpaid', 'none'].includes(p.status)) return false;
  }
  if (b.pins !== undefined && (typeof b.pins !== 'object' || b.pins === null || Object.entries(b.pins).some(([k, v]) => !findStudent(k) || !validPin(v)))) return false;
  if (b.audit !== undefined && !Array.isArray(b.audit)) return false;
  if (b.incomes !== undefined && (!Array.isArray(b.incomes) || !b.incomes.every((i) => i && typeof i.id === 'string' && Number.isFinite(i.amount) && i.amount > 0 && typeof i.source === 'string' && typeof i.at === 'string'))) return false;
  return b.withdrawals.every((w) => w && typeof w.id === 'string' && Number.isFinite(w.amount) && w.amount > 0 && typeof w.reason === 'string' && typeof w.at === 'string');
}
app.post('/api/admin/restore', auth(['admin']), (req, res) => {
  if (!validBackup(req.body)) return res.status(400).json({ error: 'Invalid backup file, or months/students do not match the current system' });
  payments = req.body.payments;
  withdrawals = req.body.withdrawals;
  incomes = req.body.incomes || [];
  pins = req.body.pins || {};
  audit = Array.isArray(req.body.audit) ? req.body.audit : [];
  logAct(req.user.name, 'Imported backup', `${Object.keys(payments).length} student · ${withdrawals.length} Withdrawal`);
  save();
  res.json({ ok: true, students: Object.keys(payments).length, withdrawals: withdrawals.length });
});

// ---- Withdrawals (admin): create / edit / delete (optional receipt image)
function parseWithdrawal(body) {
  const amount = round2(Number(body && body.amount));
  const reason = String((body && body.reason) || '').trim();
  const date = body && body.date ? String(body.date) : todayStr();
  const rc = body && body.receipt;
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Please enter an amount greater than 0' };
  if (!reason) return { error: 'Please provide a withdrawal reason' };
  if (reason.length > 200) return { error: 'Reason exceeds 200 characters' };
  if (!validDate(date)) return { error: 'Invalid date' };
  if (date > todayStr()) return { error: 'Withdrawal date cannot be in the future' };
  if (rc && (typeof rc !== 'string' || !IMG_RE.test(rc.slice(0, 40)) || rc.length > 8e6)) return { error: 'Receipt must be a PNG/JPG/WEBP image no larger than ~6MB' };
  return { amount, reason, date, receipt: rc || undefined };
}

app.post('/api/admin/withdraw', auth(['admin']), (req, res) => {
  const p = parseWithdrawal(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  const balance = balanceNow();
  if (p.amount > balance) return res.status(400).json({ error: `Insufficient balance (Balance ${balance} THB)` });
  const w = { id: crypto.randomBytes(4).toString('hex'), amount: p.amount, reason: p.reason, date: p.date, by: req.user.name, at: new Date().toISOString() };
  if (p.receipt) w.receipt = p.receipt;
  withdrawals.push(w);
  logAct(req.user.name, 'Withdraw Funds', `${p.amount} THB · ${p.reason} · Date ${p.date}${p.receipt ? ' · Receipt attached' : ''}`);
  save();
  res.json({ ok: true, balance: round2(balance - p.amount) });
});

app.put('/api/admin/withdraw/:id', auth(['admin']), (req, res) => {
  const w = withdrawals.find((x) => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'Withdrawal not found' });
  const p = parseWithdrawal(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  const balance = round2(balanceNow() + w.amount);
  if (p.amount > balance) return res.status(400).json({ error: `Insufficient balance (maximum withdrawal is ${balance} THB)` });
  const old = `${w.amount} THB · ${w.reason}`;
  Object.assign(w, { amount: p.amount, reason: p.reason, date: p.date, editedBy: req.user.name, editedAt: new Date().toISOString() });
  if (p.receipt) w.receipt = p.receipt; else if (req.body.removeReceipt) delete w.receipt;
  logAct(req.user.name, 'Edited withdrawal', `From ${old} → ${p.amount} THB · ${p.reason} · Date ${p.date}`);
  save();
  res.json({ ok: true });
});

app.delete('/api/admin/withdraw/:id', auth(['admin']), (req, res) => {
  const i = withdrawals.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Withdrawal not found' });
  const [w] = withdrawals.splice(i, 1);
  logAct(req.user.name, 'Deleted withdrawal', `${w.amount} THB · ${w.reason}`);
  save();
  res.json({ ok: true });
});

// ---- Other income (admin): money received besides the monthly fee (donations, event sales, leftovers...)
function parseIncome(body) {
  const amount = round2(Number(body && body.amount));
  const source = String((body && body.source) || '').trim();
  const date = body && body.date ? String(body.date) : todayStr();
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Please enter an amount greater than 0' };
  if (!source) return { error: 'Please enter where the income came from' };
  if (source.length > 200) return { error: 'Description exceeds 200 characters' };
  if (!validDate(date)) return { error: 'Invalid date' };
  if (date > todayStr()) return { error: 'Income date cannot be in the future' };
  return { amount, source, date };
}
app.post('/api/admin/income', auth(['admin']), (req, res) => {
  const p = parseIncome(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  incomes.push({ id: crypto.randomBytes(4).toString('hex'), ...p, by: req.user.name, at: new Date().toISOString() });
  logAct(req.user.name, 'Recorded income', `${p.amount} THB · ${p.source} · Date ${p.date}`);
  save();
  res.json({ ok: true, balance: balanceNow() });
});
app.put('/api/admin/income/:id', auth(['admin']), (req, res) => {
  const i = incomes.find((x) => x.id === req.params.id);
  if (!i) return res.status(404).json({ error: 'Income record not found' });
  const p = parseIncome(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  if (balanceNow() - i.amount + p.amount < 0) return res.status(400).json({ error: 'Cannot lower this income: the room fund balance would go negative' });
  const old = `${i.amount} THB · ${i.source}`;
  Object.assign(i, { ...p, editedBy: req.user.name, editedAt: new Date().toISOString() });
  logAct(req.user.name, 'Edited income', `From ${old} → ${p.amount} THB · ${p.source} · Date ${p.date}`);
  save();
  res.json({ ok: true });
});
app.delete('/api/admin/income/:id', auth(['admin']), (req, res) => {
  const k = incomes.findIndex((x) => x.id === req.params.id);
  if (k < 0) return res.status(404).json({ error: 'Income record not found' });
  if (balanceNow() - incomes[k].amount < 0) return res.status(400).json({ error: 'Cannot delete: the room fund balance would go negative' });
  const [i] = incomes.splice(k, 1);
  logAct(req.user.name, 'Deleted income', `${i.amount} THB · ${i.source}`);
  save();
  res.json({ ok: true });
});

// ---- Fallbacks
app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));
app.get('*', sendPage('index.html'));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'File too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid data format' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

init()
  .then(() => app.listen(PORT, () => console.log(`Class Fund 3/A running on port ${PORT}`)))
  .catch((e) => { console.error('startup failed:', e); process.exit(1); });
