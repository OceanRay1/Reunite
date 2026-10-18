const express = require('express');
const initSqlJs = require('sql.js');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const STAFF_PIN = process.env.STAFF_PIN || '1234';
const RETENTION_DAYS = +(process.env.RETENTION_DAYS || 30);
const THRESHOLD = 0.72;
const DB_PATH = process.env.DB_PATH || 'data.db';

let db = null;

async function initDb() {
  const SQL = await initSqlJs();
  let data;
  try { data = fs.readFileSync(DB_PATH); } catch { data = null; }
  db = new SQL.Database(data);
  
  db.run(`CREATE TABLE IF NOT EXISTS people(
    id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT, age INTEGER, age_group TEXT,
    description TEXT, shelter TEXT, visibility TEXT DEFAULT 'ask', contact_note TEXT,
    created_at INTEGER, updated_at INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS reports(
    id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT, age INTEGER, description TEXT,
    seeker_name TEXT, seeker_contact TEXT, message TEXT, created_at INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS matches(
    id INTEGER PRIMARY KEY, report_id INTEGER, person_id INTEGER, score REAL,
    status TEXT DEFAULT 'pending', UNIQUE(report_id, person_id))`);
  
  writeNow();
}

// Writes are coalesced so many statements in one request (ex: a bulk import) trigger ONE file write
let saveTimer = null;
function writeNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, DB_PATH); 
}
function saveDb() { if (!saveTimer) saveTimer = setTimeout(writeNow, 250); }
function flushAndExit() { try { if (db) writeNow(); } finally { process.exit(0); } }
process.on('SIGTERM', flushAndExit);
process.on('SIGINT', flushAndExit);

function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Helpers 
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; 
const newCode = () => Array.from({ length: 6 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
const now = () => Date.now();
const clean = (s, n = 300) => (s == null ? '' : String(s).trim().slice(0, n));
const toAge = (a) => { const n = parseInt(a, 10); return Number.isFinite(n) && n >= 0 && n < 120 ? n : null; };
const norm = (s) => clean(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// Help be tolerant of spelling variants, order swaps, missing middle names, and o/slight changes
function nameScore(a, b) {
  const A = norm(a), B = norm(b);
  if (!A.length || !B.length) return 0;
  // A single-word name only matches another single-word name, so "James" never matches "James Carter"
  if (A.length !== B.length && Math.min(A.length, B.length) === 1) return 0;
  const [short, long] = A.length <= B.length ? [A, B] : [B, A];
  let total = 0;
  for (const t of short) total += Math.max(...long.map((u) => 1 - lev(t, u) / Math.max(t.length, u.length)));
  return total / short.length;
}
function ageOk(a, b, group) {
  if (a == null || b == null) return true;
  return Math.abs(a - b) <= (group === 'child' ? 3 : 10);
}

function matchPair(report, person) {
  if (person.visibility === 'hidden') return; // hidden people are never matched
  if (!ageOk(report.age, person.age, person.age_group)) return;
  const score = nameScore(report.name, person.name);
  if (score >= THRESHOLD)
    dbRun('INSERT OR IGNORE INTO matches(report_id, person_id, score) VALUES(?,?,?)', [report.id, person.id, score]);
}

const sha = (x) => crypto.createHash('sha256').update(String(x)).digest();
const PIN_HASH = sha(STAFF_PIN);
const isStaff = (req) => { const h = req.get('x-staff-pin'); return !!h && crypto.timingSafeEqual(sha(h), PIN_HASH); };
const staffOnly = (req, res, next) => (isStaff(req) ? next() : res.status(401).json({ error: 'Staff PIN required' }));

function purge() {
  if (!db) return;
  const cutoff = now() - RETENTION_DAYS * 86400000;
  dbRun('DELETE FROM matches WHERE person_id IN (SELECT id FROM people WHERE updated_at < ?) OR report_id IN (SELECT id FROM reports WHERE created_at < ?)', [cutoff, cutoff]);
  dbRun('DELETE FROM people WHERE updated_at < ?', [cutoff]);
  dbRun('DELETE FROM reports WHERE created_at < ?', [cutoff]);
}

function createPerson(b, forcedCode) {
  const age = toAge(b.age);
  let group = ['child', 'adult', 'senior'].includes(b.ageGroup) ? b.ageGroup : age != null ? (age < 18 ? 'child' : age >= 65 ? 'senior' : 'adult') : 'adult';
  if (age != null && age < 18) group = 'child';
  let vis = ['open', 'ask', 'hidden'].includes(b.visibility) ? b.visibility : 'ask';
  if (group === 'child' && vis === 'open') vis = 'ask'; // children NEVER publicly listed
  const code = forcedCode || newCode();
  dbRun(
    `INSERT INTO people(code,name,age,age_group,description,shelter,visibility,contact_note,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [code, clean(b.name, 100), age, group, clean(b.description, 500), clean(b.shelter, 120),
        vis, clean(b.contactNote, 200), now(), now()]
  );
  const person = dbGet('SELECT * FROM people WHERE code=?', [code]);
  rematch(person);
  return person;
}
function rematch(person) {
  if (person.visibility === 'hidden') return;
  for (const r of dbAll('SELECT * FROM reports')) matchPair(r, person);
}

// App 
const app = express();
app.set('trust proxy', 1); 
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const limiter = (o) => rateLimit({
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests from this device. Please wait a minute, or ask a staff member for help.' }, ...o,
});
// Staff (correct PIN) are exempt everywhere bc a whole shelter may share one IP.
app.use('/api', limiter({ windowMs: 60000, limit: 120, skip: isStaff }));
const strict = limiter({ windowMs: 60000, limit: 30, skip: isStaff }); // anti-scraping on public search
// Code guessing: ONLY failed attempts (404/403) count so honest lookups never lock out families
const codeLimit = limiter({ windowMs: 60000, limit: 20, skip: isStaff, skipSuccessfulRequests: true });
// PIN guessing: only wrong PINs count
const pinLimit = limiter({ windowMs: 60000, limit: 10, skip: isStaff, skipSuccessfulRequests: true });
// Anti-flooding on writes
const writeLimit = (max) => limiter({ windowMs: 10 * 60 * 1000, limit: max, skip: isStaff });

// The browser sends one key per form fill, so double taps return the SAME record
// Still two different people with identical details still get different codes
const idem = new Map();
const idemGet = (req, b) => { const k = clean(b.idemKey, 64); const e = k && idem.get(req.path + k); return e && e.exp > now() ? e.resp : null; };
const idemSet = (req, b, resp) => {
  const k = clean(b.idemKey, 64); if (!k) return;
  if (idem.size > 5000) for (const [key, e] of idem) if (e.exp < now()) idem.delete(key);
  idem.set(req.path + k, { resp, exp: now() + 10 * 60 * 1000 });
};

// Check in ("I'm safe") which usable by the person or a volunteer on a shared device
app.post('/api/people', writeLimit(30), (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ code: 'XXXXXX', name: '', visibility: 'ask', ageGroup: 'adult' }); // honeypot: bots fill hidden field
  const prev = idemGet(req, b);
  if (prev) return res.json(prev);
  const p = createPerson(b);
  const resp = { code: p.code, name: p.name, visibility: p.visibility, ageGroup: p.age_group };
  idemSet(req, b, resp);
  res.json(resp);
});

// Public search ONLY people who chose "open" (not children or 'ask'/'hidden' option)
app.post('/api/search', strict, (req, res) => {
  const { name, age } = req.body || {};
  if (!clean(name)) return res.status(400).json({ error: 'Please enter a name' });
  const a = toAge(age);
  const rows = dbAll("SELECT * FROM people WHERE visibility='open' AND age_group!='child'");
  const out = rows
    .filter((p) => ageOk(a, p.age, p.age_group))
    .map((p) => ({ p, s: nameScore(name, p.name) }))
    .filter((x) => x.s >= THRESHOLD)
    .sort((x, y) => y.s - x.s).slice(0, 10)
    .map(({ p }) => ({ name: p.name, ageGroup: p.age_group, description: p.description, shelter: p.shelter, updated: p.updated_at }));
  res.json({ results: out });
});

// "Leave a note" where seeker registers who they're looking for which matches now and on future check-ins
app.post('/api/reports', writeLimit(10), (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ code: 'XXXXXX' });
  if (!clean(b.name)) return res.status(400).json({ error: 'Who are you looking for?' });
  const prev = idemGet(req, b);
  if (prev) return res.json(prev);
  const code = newCode();
  dbRun(
    `INSERT INTO reports(code,name,age,description,seeker_name,seeker_contact,message,created_at) VALUES(?,?,?,?,?,?,?,?)`,
    [code, clean(b.name, 100), toAge(b.age), clean(b.description, 500), clean(b.seekerName, 100),
        clean(b.seekerContact, 200), clean(b.message, 500), now()]
  );
  const report = dbGet('SELECT * FROM reports WHERE code=?', [code]);
  for (const p of dbAll("SELECT * FROM people WHERE visibility!='hidden'")) matchPair(report, p);
  const resp = { code };
  idemSet(req, b, resp);
  res.json(resp); // Same response whether or not a match exists
});

// Look up by code: one endpoint for both kinds of code so a wrong guess is exactly one failed request
app.get('/api/lookup/:code', codeLimit, (req, res) => {
  const code = clean(req.params.code).toUpperCase();
  const p = dbGet('SELECT * FROM people WHERE code=?', [code]);
  if (p) {
    // Person view: pending requests from people looking for them
    const requests = dbAll(
      `SELECT m.id, r.seeker_name, r.seeker_contact, r.message FROM matches m JOIN reports r ON r.id=m.report_id
       WHERE m.person_id=? AND m.status='pending'`, [p.id]);
    return res.json({ kind: 'person', name: p.name, shelter: p.shelter, visibility: p.visibility, ageGroup: p.age_group, contactNote: p.contact_note, requests });
  }
  const r = dbGet('SELECT * FROM reports WHERE code=?', [code]);
  if (!r) return res.status(404).json({ error: 'Code not found' });
  // Seeker view: a declined match looks identical to "still waiting" (no signal that someone is here)
  const found = dbAll(
    `SELECT p.shelter, p.contact_note FROM matches m JOIN people p ON p.id=m.person_id WHERE m.report_id=? AND m.status='accepted'`, [r.id]);
  res.json({ kind: 'report', lookingFor: r.name, status: found.length ? 'found' : 'waiting', connections: found });
});

// Accept / decline (Children's requests need staff (PIN) so no one hands a child to a stranger)
app.post('/api/people/:code/respond', codeLimit, (req, res) => {
  const p = dbGet('SELECT * FROM people WHERE code=?', [clean(req.params.code).toUpperCase()]);
  if (!p) return res.status(404).json({ error: 'Code not found' });
  if (p.age_group === 'child' && !isStaff(req)) return res.status(403).json({ error: 'A staff member must approve contact for children.' });
  const status = req.body.accept ? 'accepted' : 'declined';
  dbRun('UPDATE matches SET status=? WHERE id=? AND person_id=? AND status=\'pending\'', [status, req.body.matchId, p.id]);
  res.json({ ok: true });
});

app.post('/api/people/:code/update', codeLimit, (req, res) => {
  const p = dbGet('SELECT * FROM people WHERE code=?', [clean(req.params.code).toUpperCase()]);
  if (!p) return res.status(404).json({ error: 'Code not found' });
  const b = req.body || {};
  const vis = ['open', 'ask', 'hidden'].includes(b.visibility) ? b.visibility : p.visibility;
  const finalVis = p.age_group === 'child' && vis === 'open' ? 'ask' : vis;
  dbRun('UPDATE people SET shelter=?, contact_note=?, visibility=?, updated_at=? WHERE id=?',
    [b.shelter != null ? clean(b.shelter, 120) : p.shelter, b.contactNote != null ? clean(b.contactNote, 200) : p.contact_note,
         finalVis, now(), p.id]);
  // Going "hidden" withdraws every pending/accepted link & leaving "hidden" picks up notes left earlier
  if (finalVis === 'hidden') dbRun('DELETE FROM matches WHERE person_id=?', [p.id]);
  else rematch(dbGet('SELECT * FROM people WHERE id=?', [p.id]));
  res.json({ ok: true });
});

// Right to disappear (delete EVERYTHING about me)
app.delete('/api/people/:code', codeLimit, (req, res) => {
  const p = dbGet('SELECT id FROM people WHERE code=?', [clean(req.params.code).toUpperCase()]);
  if (!p) return res.status(404).json({ error: 'Code not found' });
  dbRun('DELETE FROM matches WHERE person_id=?', [p.id]); dbRun('DELETE FROM people WHERE id=?', [p.id]);
  res.json({ ok: true });
});

// Staff
app.get('/api/staff/overview', pinLimit, staffOnly, (req, res) => {
  const q = clean(req.query.q).toLowerCase();
  let people = dbAll('SELECT * FROM people ORDER BY updated_at DESC LIMIT 500');
  if (q) people = people.filter((p) => (p.name + ' ' + p.shelter + ' ' + p.code).toLowerCase().includes(q));
  const pending = dbAll(
    `SELECT m.id, m.score, p.code, p.name AS person_name, p.age AS person_age, p.description AS person_desc, p.shelter, p.age_group, r.name AS looking_for, r.age AS looking_age, r.description AS looking_desc, r.seeker_name, r.seeker_contact, r.message
     FROM matches m JOIN people p ON p.id=m.person_id JOIN reports r ON r.id=m.report_id WHERE m.status='pending' ORDER BY m.score DESC, m.id DESC`);
  const pc = dbGet('SELECT COUNT(*) as c FROM people');
  const rc = dbGet('SELECT COUNT(*) as c FROM reports');
  res.json({ people, pending, counts: { people: pc?.c || 0, reports: rc?.c || 0 } });
});

// A bulk import for paper records
app.post('/api/staff/import', pinLimit, staffOnly, (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 2000) : [];
  const codes = rows.map((r) => createPerson(r).code);
  res.json({ imported: codes.length });
});

function seedDemo() {
  if (process.env.SEED_DEMO !== '1' || dbGet('SELECT COUNT(*) AS c FROM people').c > 0) return;
  // Fixed codes for the README walkthrough
  createPerson({ name: 'James Carter', age: 71, ageGroup: 'senior', shelter: 'Riverside Community Center', visibility: 'open', description: 'Grey beard, walks with a cane, from Harbor St.' }, 'JAMES2');
  createPerson({ name: 'Maria Gonzalez', age: 34, shelter: 'Lincoln High School', visibility: 'ask', description: 'Two kids, red jacket' }, 'MARIA2');
  createPerson({ name: 'Dani', age: 16, ageGroup: 'child', shelter: 'Eastside Shelter', visibility: 'ask', description: 'Came on the school bus' }, 'DANI22');
  createPerson({ name: '', shelter: 'Lincoln High School', visibility: 'hidden' });
  const code = 'ANA222';
  dbRun('INSERT INTO reports(code,name,age,description,seeker_name,seeker_contact,message,created_at) VALUES(?,?,?,?,?,?,?,?)',
    [code, 'Maria Gonzales', 35, '', 'Ana (sister)', 'Staying at Hampton Inn, ask front desk', 'I am safe. Where are you?', now()]);
  matchPair(dbGet('SELECT * FROM reports WHERE code=?', [code]), dbGet("SELECT * FROM people WHERE code='MARIA2'"));
  console.log('Demo data loaded');
}
initDb().then(() => {
  seedDemo();
  purge();
  setInterval(purge, 6 * 3600 * 1000);
  app.listen(PORT, () => console.log('Reunite running on port ' + PORT));
}).catch((err) => { console.error('Failed to init database:', err); process.exit(1); });
