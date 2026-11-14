/**
 * USCW API – Cloudflare Worker + D1
 *
 * Auth: email as username, PBKDF2-SHA256 (100k iterations, per-user salt), failed-attempt
 * lockout, 30-day random session tokens (only a SHA-256 hash is stored), email confirmation
 * and 1-hour password-reset links sent through the Brevo email API. `users.is_admin` = CEO.
 */

const enc = new TextEncoder();

const PBKDF2_ITERATIONS = 100000;      // Workers' PBKDF2 maximum
const SESSION_MS = 30 * 24 * 3600 * 1000;
const VERIFY_MS = 24 * 3600 * 1000;
const RESET_MS = 3600 * 1000;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;
const MAX_EMAILS_PER_ADDRESS_PER_HOUR = 3;
const MAX_EMAILS_PER_DAY = 250;        // global cap, under Brevo's free 300/day
const BAD_LOGIN = 'Incorrect email or password';
const DUMMY_SALT = '00112233445566778899aabbccddeeff'; // keeps timing similar for unknown emails

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

/* ---------------- crypto helpers ---------------- */
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
function randHex(bytes) { const a = new Uint8Array(bytes); crypto.getRandomValues(a); return hex(a); }
async function sha256Hex(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function pbkdf2Hex(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations }, key, 256);
  return hex(bits);
}
// Stored as "<iterations>:<hex hash>" so the cost can be raised later. A bare hash (older accounts) means 100000.
async function hashPassword(password, saltHex) {
  return `${PBKDF2_ITERATIONS}:${await pbkdf2Hex(password, saltHex, PBKDF2_ITERATIONS)}`;
}
async function verifyPassword(password, stored, saltHex) {
  const parts = String(stored).split(':');
  const iterations = parts.length === 2 ? parseInt(parts[0], 10) : PBKDF2_ITERATIONS;
  const hashHex = parts.length === 2 ? parts[1] : parts[0];
  if (!iterations || !hashHex) return false;
  return timingSafeEqual(await pbkdf2Hex(password, saltHex, iterations), hashHex);
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ---------------- http helpers ---------------- */
function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const h = { 'Vary': 'Origin' };
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    h['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
async function readJson(request, limit = 256 * 1024) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > limit) throw new HttpError(413, 'Request too large');
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw 0;
    return body;
  } catch { throw new HttpError(400, 'Invalid request body'); }
}

/* ---------------- validation helpers ---------------- */
function normEmail(v) {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e)) return null;
  return e;
}
function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 8 || p.length > 128)
    throw new HttpError(400, 'Password must be 8 to 128 characters long.');
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* ---------------- email (Brevo transactional API over HTTPS) ---------------- */
async function sendEmail(env, { to, subject, text, html }) {
  if (!env.BREVO_API_KEY) {
    // Local development: no Brevo key, so print the message instead of sending it.
    console.log(`\n--- EMAIL (not sent: BREVO_API_KEY not set) ---\nTo: ${to}\nSubject: ${subject}\n\n${text}\n----------------------------------------------\n`);
    return;
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'USCW', email: env.SENDER_EMAIL },
      to: [{ email: to }],
      subject, textContent: text, htmlContent: html
    })
  });
  if (!res.ok) throw new Error('Brevo send failed: ' + res.status + ' ' + (await res.text()).slice(0, 300));
}

function emailHtml(heading, intro, buttonLabel, link, footer) {
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #d3dbea;background:#ffffff;color:#0a1a3f">
<div style="background:#0a1f5c;color:#ffffff;padding:16px 28px;border-bottom:6px solid #c8102e;font-size:22px;font-weight:bold;letter-spacing:2px">&#9733; US<span style="color:#ff7b91">CW</span></div>
<div style="padding:28px"><h2 style="margin:0 0 12px;color:#0a1f5c">${heading}</h2><p style="line-height:1.5">${intro}</p>
<p style="margin:24px 0"><a href="${link}" style="background:#c8102e;color:#ffffff;padding:12px 22px;text-decoration:none;font-weight:bold;border-radius:4px;display:inline-block">${buttonLabel}</a></p>
<p style="font-size:13px;color:#56627f">Or paste this link into your browser:<br><a href="${link}" style="color:#1d4ed8;word-break:break-all">${link}</a></p>
<p style="font-size:13px;color:#56627f">${footer}</p></div></div>`;
}

// True when the global daily email cap has been reached.
async function dailyCapReached(env) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_log WHERE sent_at > ?').bind(Date.now() - 24 * 3600 * 1000).first();
  return !!r && r.n >= MAX_EMAILS_PER_DAY;
}
// Creates a single-use token. Returns null (silently) when an email limit is hit, so callers answer the same way every time.
async function issueEmailToken(env, userId, email, kind, ttl) {
  const now = Date.now();
  const per = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_log WHERE email = ? AND sent_at > ?').bind(email, now - 3600 * 1000).first();
  if (per && per.n >= MAX_EMAILS_PER_ADDRESS_PER_HOUR) return null;
  if (await dailyCapReached(env)) return null;
  await env.DB.prepare('DELETE FROM email_tokens WHERE user_id = ? AND kind = ?').bind(userId, kind).run();
  const token = randHex(32);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO email_tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256Hex(token), userId, kind, now + ttl),
    env.DB.prepare('INSERT INTO email_log (email, sent_at) VALUES (?, ?)').bind(email, now)
  ]);
  return token;
}
async function sendVerification(env, userId, email) {
  const token = await issueEmailToken(env, userId, email, 'verify', VERIFY_MS);
  if (!token) return;
  const link = `${env.SITE_URL}/#verify-${token}`;
  await sendEmail(env, {
    to: email, subject: 'Confirm your USCW account',
    text: `Welcome to United States Championship Wrestling!\n\nConfirm your email address to activate your account:\n${link}\n\nThis link is valid for 24 hours. If you didn't sign up, you can ignore this email.`,
    html: emailHtml('Welcome to USCW', 'Confirm your email address to activate your account and create your wrestler.', 'Confirm my email', link, 'This link is valid for 24 hours. If you didn\'t sign up, you can ignore this email.')
  });
}
async function sendReset(env, userId, email) {
  const token = await issueEmailToken(env, userId, email, 'reset', RESET_MS);
  if (!token) return;
  const link = `${env.SITE_URL}/#reset-${token}`;
  await sendEmail(env, {
    to: email, subject: 'Reset your USCW password',
    text: `Someone asked to reset the password for this USCW account.\n\nChoose a new password here (valid for 1 hour):\n${link}\n\nIf this wasn't you, you can ignore this email.`,
    html: emailHtml('Reset your password', 'Someone asked to reset the password for this USCW account. The link below is valid for 1 hour.', 'Choose a new password', link, 'If this wasn\'t you, you can ignore this email and your password will stay the same.')
  });
}

/* ---------------- sessions ---------------- */
async function createSession(env, userId) {
  const token = randHex(32);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, now, now + SESSION_MS).run();
  return token;
}
async function getUser(request, env, required) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer ([a-f0-9]{64})$/);
  if (m) {
    const row = await env.DB.prepare(
      `SELECT u.id, u.email, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await sha256Hex(m[1]), Date.now()).first();
    if (row) return { id: row.id, email: row.email, isAdmin: !!row.is_admin, tokenHash: await sha256Hex(m[1]) };
  }
  if (required) throw new HttpError(401, 'Please log in.', 'auth');
  return null;
}
const publicUser = u => ({ id: u.id, email: u.email, isAdmin: !!u.isAdmin });

async function cleanup(env) {
  const now = Date.now();
  await ensureViews(env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM show_views WHERE started_at < ?').bind(now - 3 * 24 * 3600 * 1000),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM email_tokens WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM email_log WHERE sent_at < ?').bind(now - 2 * 24 * 3600 * 1000),
    env.DB.prepare('DELETE FROM login_attempts WHERE locked_until < ? AND updated_at < ?').bind(now, now - 24 * 3600 * 1000)
  ]);
}

/* ---------------- auth routes ---------------- */
async function register(request, env) {
  const body = await readJson(request);
  const email = normEmail(body.email);
  if (!email) throw new HttpError(400, 'Please enter a valid email address.');
  checkPassword(body.password);
  if (await dailyCapReached(env)) throw new HttpError(503, 'Sign-ups are paused for today. Please try again tomorrow.');
  const generic = json({ ok: true, message: 'Almost there! If that address can be registered, a confirmation email is on its way.' });

  const existing = await env.DB.prepare('SELECT id, email_verified FROM users WHERE email = ?').bind(email).first();
  if (existing) {  // never reveal that the account exists
    if (!existing.email_verified) await sendVerification(env, existing.id, email).catch(e => console.error(e));
    return generic;
  }
  const salt = randHex(16);
  const hash = await hashPassword(body.password, salt);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, email, pw_hash, pw_salt, email_verified, is_admin, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
    .bind(id, email, hash, salt, Date.now()).run();
  await sendVerification(env, id, email).catch(e => console.error(e));
  return generic;
}

async function resendVerification(request, env) {
  const body = await readJson(request);
  const email = normEmail(body.email);
  if (email) {
    const u = await env.DB.prepare('SELECT id, email_verified FROM users WHERE email = ?').bind(email).first();
    if (u && !u.email_verified) await sendVerification(env, u.id, email).catch(e => console.error(e));
  }
  return json({ ok: true, message: 'If that account needs confirming, a new email is on its way.' });
}

// Uses a link exactly once: the delete only succeeds for the first caller, so two simultaneous clicks can't both win.
async function consumeToken(env, token, kind) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT user_id FROM email_tokens WHERE token_hash = ? AND kind = ? AND expires_at > ?')
    .bind(hash, kind, Date.now()).first();
  if (!row) return null;
  const del = await env.DB.prepare('DELETE FROM email_tokens WHERE token_hash = ?').bind(hash).run();
  if (del.meta && del.meta.changes === 0) return null;
  return { userId: row.user_id, hash };
}

async function verifyEmail(request, env) {
  const body = await readJson(request);
  const t = await consumeToken(env, body.token, 'verify');
  if (!t) throw new HttpError(400, 'This confirmation link is invalid or has expired. Log in to request a new one.');
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').bind(t.userId),
    env.DB.prepare('DELETE FROM email_tokens WHERE user_id = ? AND kind = ?').bind(t.userId, 'verify')
  ]);
  return json({ ok: true });
}

async function login(request, env) {
  const body = await readJson(request);
  const email = normEmail(body.email);
  const password = body.password;
  if (!email || typeof password !== 'string' || password.length < 1 || password.length > 128)
    throw new HttpError(401, BAD_LOGIN);

  const now = Date.now();
  const att = await env.DB.prepare('SELECT failed, locked_until FROM login_attempts WHERE email = ?').bind(email).first();
  if (att && att.locked_until > now)
    throw new HttpError(429, 'Too many failed attempts. Please wait a few minutes and try again.', 'locked');

  const user = await env.DB.prepare('SELECT id, email, pw_hash, pw_salt, email_verified, is_admin FROM users WHERE email = ?').bind(email).first();
  const ok = user
    ? await verifyPassword(password, user.pw_hash, user.pw_salt)
    : (await pbkdf2Hex(password, DUMMY_SALT, PBKDF2_ITERATIONS), false);   // same work, so timing doesn't reveal unknown emails

  if (!ok) {
    // a lock that has expired starts the count over
    const prior = att && !(att.locked_until && att.locked_until <= now) ? att.failed : 0;
    const failed = prior + 1;
    const lockedUntil = failed >= MAX_FAILED_LOGINS ? now + LOCK_MS : 0;
    await env.DB.prepare(
      `INSERT INTO login_attempts (email, failed, locked_until, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET failed = excluded.failed, locked_until = excluded.locked_until, updated_at = excluded.updated_at`)
      .bind(email, failed, lockedUntil, now).run();
    throw new HttpError(401, BAD_LOGIN);
  }
  if (!user.email_verified)
    throw new HttpError(403, 'Please confirm your email address first. Check your inbox for the confirmation link.', 'unverified');

  await env.DB.prepare('DELETE FROM login_attempts WHERE email = ?').bind(email).run();
  await cleanup(env);
  const token = await createSession(env, user.id);
  return json({ token, user: { id: user.id, email: user.email, isAdmin: !!user.is_admin } });
}

async function logout(request, env) {
  const user = await getUser(request, env, true);
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(user.tokenHash).run();
  return json({ ok: true });
}

async function forgot(request, env) {
  const body = await readJson(request);
  const email = normEmail(body.email);
  if (email) {
    const u = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (u) await sendReset(env, u.id, email).catch(e => console.error(e));
  }
  return json({ ok: true, message: 'If an account exists for that address, a password reset email is on its way.' });
}

async function resetPassword(request, env) {
  const body = await readJson(request);
  checkPassword(body.password);
  const t = await consumeToken(env, body.token, 'reset');
  if (!t) throw new HttpError(400, 'This reset link is invalid or has expired. Please request a new one.');
  const salt = randHex(16);
  const hash = await hashPassword(body.password, salt);
  const u = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(t.userId).first();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, email_verified = 1 WHERE id = ?').bind(hash, salt, t.userId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(t.userId),            // sign out everywhere
    env.DB.prepare('DELETE FROM email_tokens WHERE user_id = ? AND kind = ?').bind(t.userId, 'reset'),
    env.DB.prepare('DELETE FROM login_attempts WHERE email = ?').bind(u ? u.email : '')
  ]);
  return json({ ok: true });
}

/* ---------------- wrestlers ---------------- */
const ALIGNMENTS = ['Face', 'Heel', 'Tweener'];
const MOVE_KEYS = ['strikes', 'grapples', 'submissions', 'aerial', 'signature'];

const MOVE_LABELS = { strikes: 'Strikes & Kicks', grapples: 'Slams, Suplexes & Power Moves', submissions: 'Submissions', aerial: 'High-Flying & Aerial', signature: 'Signature Moves & Taunts' };
function cleanWrestler(b) {
  const need = (v, label) => { if (!v) throw new HttpError(400, label + ' is required.'); return v; };
  const ringName = need(str(b.ringName, 60), 'Ring name');
  const nickname = need(str(b.nickname, 80), 'Nickname');
  const realName = need(str(b.realName, 80), 'Your name');
  const hometown = need(str(b.hometown, 80), 'Hometown');
  const height = need(str(b.height, 20), 'Height');
  const weight = need(str(b.weight, 10), 'Weight');
  const age = need(str(b.age, 10), 'Age');
  if (!/^\d{2,3}$/.test(weight) || +weight < 50 || +weight > 700) throw new HttpError(400, 'Weight must be a number of pounds (50-700).');
  if (!/^\d{2}$/.test(age) || +age < 16 || +age > 99) throw new HttpError(400, 'Age must be a number from 16 to 99.');
  if (!ALIGNMENTS.includes(b.alignment)) throw new HttpError(400, 'Alignment is required.');
  const style = need(str(b.style, 60), 'Wrestling style');
  const theme = need(str(b.theme, 100), 'Entrance theme music');
  const bio = need(str(b.bio, 4000), 'Biography');
  const moves = {};
  const inMoves = b.moves && typeof b.moves === 'object' ? b.moves : {};
  for (const k of MOVE_KEYS) {
    moves[k] = (Array.isArray(inMoves[k]) ? inMoves[k] : []).map(m => str(m, 120)).filter(Boolean).slice(0, 60);
    if (!moves[k].length) throw new HttpError(400, 'Add at least one move under ' + (MOVE_LABELS[k] || k) + '.');
  }
  const fin = b.finisher && typeof b.finisher === 'object' ? b.finisher : {};
  const finName = need(str(fin.name, 80), 'Finisher name');
  const finDesc = need(str(fin.desc, 600), 'Finisher description');
  return {
    ringName, nickname, realName, age, hometown, height, weight,
    alignment: b.alignment, style, theme, bio,
    moves, finisher: { name: finName, desc: finDesc }
  };
}
// Real name and move set are for the CEO and the wrestler's own player only; nobody else ever receives them.
const wrestlerOut = (r, user) => {
  const w = { id: r.id, ownerId: r.owner_id, ...JSON.parse(r.data) };
  const full = user && (user.isAdmin || user.id === r.id || user.id === r.owner_id);
  if (!full) { w.realName = ''; w.moves = {}; }
  return w;
};

async function wrestlerRoutes(request, env, id) {
  const method = request.method;
  if (method === 'GET') {
    const viewer = await getUser(request, env, false);
    if (id) {
      const r = await env.DB.prepare('SELECT * FROM wrestlers WHERE id = ?').bind(id).first();
      if (!r) throw new HttpError(404, 'Wrestler not found');
      return json({ wrestler: wrestlerOut(r, viewer) });
    }
    const { results } = await env.DB.prepare('SELECT * FROM wrestlers ORDER BY ring_name COLLATE NOCASE').all();
    return json({ wrestlers: results.map(r => wrestlerOut(r, viewer)) });
  }
  const user = await getUser(request, env, true);
  if (!id) throw new HttpError(404, 'Not found');
  if (method === 'PUT') {
    if (id !== user.id && !user.isAdmin) throw new HttpError(403, 'You can only edit your own wrestler.');
    const data = cleanWrestler(await readJson(request));
    const now = Date.now();
    const existing = await env.DB.prepare('SELECT owner_id FROM wrestlers WHERE id = ?').bind(id).first();
    const owner = existing ? existing.owner_id : (id === user.id ? user.id : null);
    await env.DB.prepare(
      `INSERT INTO wrestlers (id, owner_id, ring_name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET ring_name = excluded.ring_name, data = excluded.data, updated_at = excluded.updated_at`)
      .bind(id, owner, data.ringName, JSON.stringify(data), now, now).run();
    return json({ ok: true, id });
  }
  if (method === 'DELETE') {
    if (!user.isAdmin) throw new HttpError(403, 'Only the CEO can release a wrestler.');
    const { results: titles } = await env.DB.prepare('SELECT id, holders FROM championships').all();
    await ensureStory(env); await ensureSubs(env);
    const stmts = [env.DB.prepare('DELETE FROM wrestlers WHERE id = ?').bind(id), env.DB.prepare('DELETE FROM wrestler_story WHERE id = ?').bind(id), env.DB.prepare('DELETE FROM submissions WHERE wrestler_id = ?').bind(id)];
    for (const t of titles) {
      if (JSON.parse(t.holders || '[]').includes(id))   // a released champion leaves the title vacant
        stmts.push(env.DB.prepare("UPDATE championships SET holders = '[]', since = '', won_at = '', updated_at = ? WHERE id = ?").bind(Date.now(), t.id));
    }
    await env.DB.batch(stmts);
    return json({ ok: true });
  }
  throw new HttpError(405, 'Method not allowed');
}

/* ---------------- storylines (CEO only) ---------------- */
// Recent results, feuds and show notes per wrestler. Only the CEO can read or change these; the intro writer uses them.
// Upcoming matches are not stored here: the front end derives them from the published cards.
let storyReady = null;
function ensureStory(env) {
  if (!storyReady) {
    storyReady = env.DB.prepare('CREATE TABLE IF NOT EXISTS wrestler_story (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)')
      .run().catch(e => { storyReady = null; throw e; });
  }
  return storyReady;
}
const RESULTS = ['Win', 'Loss', 'Draw', 'No Contest'];
const isoDate = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
const list = (v, n) => (Array.isArray(v) ? v : []).slice(0, n).map(x => (x && typeof x === 'object' ? x : {}));
const sid = x => (typeof x.id === 'string' && ID_RE.test(x.id) ? x.id : randHex(6));
function cleanStory(b) {
  return {
    results: list(b.results, 40).map(x => ({
      id: sid(x), date: isoDate(x.date), show: str(x.show, 100), opponent: str(x.opponent, 100),
      result: RESULTS.includes(x.result) ? x.result : 'Win', how: str(x.how, 200)
    })).filter(x => x.opponent),
    feuds: list(b.feuds, 20).map(x => ({
      id: sid(x), with: str(x.with, 100), reason: str(x.reason, 300)
    })).filter(x => x.with),
    notes: list(b.notes, 60).map(x => ({
      id: sid(x), date: isoDate(x.date), show: str(x.show, 100), text: str(x.text, 600)
    })).filter(x => x.text)
  };
}
async function storyRoutes(request, env, id) {
  const user = await getUser(request, env, true);
  if (!user.isAdmin) throw new HttpError(403, 'Storylines are for the CEO only.');
  await ensureStory(env);
  if (request.method === 'GET' && !id) {
    const { results } = await env.DB.prepare('SELECT id, data FROM wrestler_story').all();
    const stories = {};
    for (const r of results) { try { stories[r.id] = JSON.parse(r.data); } catch (_) { /* skip bad row */ } }
    return json({ stories });
  }
  if (request.method === 'PUT' && id) {
    const w = await env.DB.prepare('SELECT id FROM wrestlers WHERE id = ?').bind(id).first();
    if (!w) throw new HttpError(404, 'Wrestler not found');
    const data = cleanStory(await readJson(request, 100 * 1024));
    await env.DB.prepare(
      `INSERT INTO wrestler_story (id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
      .bind(id, JSON.stringify(data), Date.now()).run();
    return json({ ok: true, id });
  }
  throw new HttpError(405, 'Method not allowed');
}

/* ---------------- events ---------------- */
const SEG_TYPES = ['show_intro', 'match', 'promo', 'backstage', 'angle', 'ceremony', 'other'];
// Sound cues the show script may trigger (the audio files themselves are added later).
const CUE_RE = /^(intro_music|bell|crowd_pop|crowd_boo|crowd_chant|mat_slam|pin_count|chair_shot|entrance:[A-Za-z0-9_-]{1,40})$/;
const MAX_BEATS = 120, MAX_BEAT_CHARS = 1200, MAX_SCRIPT_CHARS = 150000;
const cleanLength = (v, type) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(30, n) : (type === 'match' ? 6 : type === 'show_intro' ? 4 : 3);
};
const cleanBeats = beats => (Array.isArray(beats) ? beats : []).slice(0, MAX_BEATS).map(b => {
  b = b && typeof b === 'object' ? b : {};
  const pause = Math.round(Number(b.pause));
  return {
    text: str(b.text, MAX_BEAT_CHARS),
    pause: Number.isFinite(pause) ? Math.max(0, Math.min(30, pause)) : 0,
    cue: typeof b.cue === 'string' && CUE_RE.test(b.cue) ? b.cue : ''
  };
}).filter(b => b.text || b.cue);

function cleanEvent(b) {
  const title = str(b.title, 100);
  if (!title) throw new HttpError(400, 'Give the show a title.');
  const date = str(b.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Pick a valid date for the show.');
  const time = str(b.time, 5);
  if (time && !/^\d{2}:\d{2}$/.test(time)) throw new HttpError(400, 'Invalid start time.');
  const segments = (Array.isArray(b.segments) ? b.segments : []).slice(0, 40).map(s => {
    s = s && typeof s === 'object' ? s : {};
    const sides = (Array.isArray(s.sides) ? s.sides : []).slice(0, 8)
      .map(side => (Array.isArray(side) ? side : []).filter(w => typeof w === 'string' && ID_RE.test(w)).slice(0, 8));
    return {
      id: typeof s.id === 'string' && ID_RE.test(s.id) ? s.id : randHex(6),
      type: SEG_TYPES.includes(s.type) ? s.type : 'other',
      title: str(s.title, 100), stip: str(s.stip, 100), desc: str(s.desc, 2000), sides,
      length: cleanLength(s.length, SEG_TYPES.includes(s.type) ? s.type : 'other'),
      beats: cleanBeats(s.beats),
      sub: typeof s.sub === 'string' && ID_RE.test(s.sub) ? s.sub : '',
      result: (SEG_TYPES.includes(s.type) && s.type === 'match' && s.result && typeof s.result === 'object')
        ? { winner: Number.isInteger(s.result.winner) && s.result.winner >= -1 && s.result.winner < sides.length ? s.result.winner : null, finish: str(s.result.finish, 300) }
        : null
    };
  });
  // Only one Show Intro per show, and it always opens the show.
  const ix = segments.findIndex(s => s.type === 'show_intro');
  if (ix >= 0) {
    const intro = segments[ix];
    for (let i = segments.length - 1; i >= 0; i--) if (segments[i].type === 'show_intro') segments.splice(i, 1);
    segments.unshift(intro);
  }
  if (segments.reduce((n, s) => n + s.beats.reduce((m, b) => m + b.text.length, 0), 0) > MAX_SCRIPT_CHARS)
    throw new HttpError(400, 'That show script is too long. Shorten some segments.');
  return {
    title, date, time, tz: str(b.tz, 10), venue: str(b.venue, 100), city: str(b.city, 100),
    notes: str(b.notes, 2000), published: !!b.published, ple: !!b.ple, segments
  };
}
// Non-match segments (promos, backstage, angles…) are surprises: only the CEO ever receives them.
const eventOut = (r, admin) => {
  const e = { id: r.id, ...JSON.parse(r.data), title: r.title, date: r.date, published: !!r.published };
  e.hasScript = (e.segments || []).some(s => Array.isArray(s.beats) && s.beats.length > 0);
  e.releaseAt = releaseAt(e);
  if (!admin) {
    // The script text is never sent to the public here; it is released a little at a time while a viewer watches the show.
    e.segments = (e.segments || []).filter(s => s.type === 'match')
      .map(({ beats, result, sub, ...s }) => ({ ...s, scripted: Array.isArray(beats) && beats.length > 0 }));
  }
  return e;
};

/* ---------------- live show script ---------------- */
// Viewers start the show themselves. The Worker only hands out text once enough time has passed since they pressed
// Start, so nobody can read ahead. Pacing comes from the text itself (about 200 words a minute) plus the CEO's pauses.
const TZ_MAP = {
  ET: 'America/New_York', EST: 'America/New_York', EDT: 'America/New_York',
  CT: 'America/Chicago', CST: 'America/Chicago', CDT: 'America/Chicago',
  MT: 'America/Denver', MST: 'America/Denver', MDT: 'America/Denver',
  PT: 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles'
};
function tzName(tz) {
  const k = String(tz || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (TZ_MAP[k]) return TZ_MAP[k];
  try { new Intl.DateTimeFormat('en-US', { timeZone: String(tz).trim() }); return String(tz).trim(); } catch { /* fall through */ }
  return 'America/New_York';
}
// The moment (ms since 1970) a wall-clock date and time occurs in a time zone.
function zonedToUtc(date, time, tz) {
  const [y, mo, d] = date.split('-').map(Number);
  const [hh, mi] = (time || '00:00').split(':').map(Number);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  const offsetAt = t => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t;
  };
  const guess = Date.UTC(y, mo - 1, d, hh, mi);
  return guess - offsetAt(guess - offsetAt(guess));
}
function releaseAt(e) {
  try { return zonedToUtc(e.date, e.time, tzName(e.tz)); } catch { return 0; }
}
const REVEAL_WPS = 3.3, BREATH = 0.25, SEG_GAP = 4;   // must match the watch page
function buildTimeline(data) {
  const beats = []; let t = 0, first = true;
  for (const s of data.segments || []) {
    const list = (s.beats || []).filter(b => b.text || b.cue);
    if (!list.length) continue;
    if (!first) t += SEG_GAP;
    first = false;
    list.forEach((b, j) => {
      const words = (b.text.match(/\S+/g) || []).length;
      const nums = /^[\s.1-4]+$/.test(b.text) ? b.text.match(/[1-4]/g) : null;   // a pin count: one second per number, the 2 of a kickout hangs about half a second
      const dur = (nums ? (nums.length - 1) + (nums[nums.length - 1] === '2' ? 0.5 : 0.1) : Math.max(1.5, words / REVEAL_WPS) + (b.text.match(/[.!?][”"')\]]*(?=\s)/g) || []).length * BREATH) + (b.pause || 0);
      beats.push({
        t, dur, text: b.text, cue: b.cue || '', pause: b.pause || 0,
        seg: j === 0 ? { id: s.id, type: s.type, title: s.title || '', stip: s.stip || '', sides: s.sides || [], length: s.length } : null
      });
      t += dur;
    });
  }
  return { beats, total: t };
}
let viewsReady = null;
function ensureViews(env) {
  if (!viewsReady) {
    viewsReady = env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS show_views (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, started_at INTEGER NOT NULL, speed INTEGER NOT NULL DEFAULT 1)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_show_views_started ON show_views(started_at)')
    ]).catch(e => { viewsReady = null; throw e; });
  }
  return viewsReady;
}
async function loadWatchable(env, id, admin) {
  const r = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
  if (!r || (!r.published && !admin)) throw new HttpError(404, 'Show not found');
  return { r, data: JSON.parse(r.data) };
}
async function watchStart(request, env, id) {
  await ensureViews(env);
  const user = await getUser(request, env, false);
  const admin = !!(user && user.isAdmin);
  const { data } = await loadWatchable(env, id, admin);
  const tl = buildTimeline(data);
  if (!tl.beats.length) throw new HttpError(404, 'This show has no live text yet.');
  if (!admin && Date.now() < releaseAt(data)) throw new HttpError(403, 'The show isn’t live yet. Come back at show time!', 'notlive');
  let body = {}; try { body = await request.json(); } catch { /* no body */ }
  const speed = admin ? Math.max(1, Math.min(20, Math.round(Number(body && body.speed)) || 1)) : 1;
  const view = randHex(12), now = Date.now();
  await env.DB.prepare('INSERT INTO show_views (id, event_id, started_at, speed) VALUES (?, ?, ?, ?)').bind(view, id, now, speed).run();
  return json({ view, speed, total: tl.beats.length, duration: Math.round(tl.total / speed) });
}
async function watchScript(request, env, id) {
  await ensureViews(env);
  const url = new URL(request.url);
  const view = url.searchParams.get('view') || '';
  if (!/^[a-f0-9]{24}$/.test(view)) throw new HttpError(400, 'Missing view.');
  const after = Math.max(0, parseInt(url.searchParams.get('after') || '0', 10) || 0);
  const user = await getUser(request, env, false);
  const admin = !!(user && user.isAdmin);
  const v = await env.DB.prepare('SELECT * FROM show_views WHERE id = ? AND event_id = ?').bind(view, id).first();
  if (!v) throw new HttpError(404, 'That viewing has expired. Start the show again.', 'noview');
  const { data } = await loadWatchable(env, id, admin);
  const tl = buildTimeline(data);
  const elapsed = (Date.now() - v.started_at) / 1000 * v.speed;
  const due = []; let nextIn = null;
  tl.beats.forEach((b, i) => {
    if (b.t <= elapsed) { if (i >= after) due.push({ i, text: b.text, cue: b.cue, pause: b.pause, dur: b.dur, seg: b.seg }); }
    else if (nextIn === null) nextIn = (b.t - elapsed) / v.speed;
  });
  return json({ beats: due, total: tl.beats.length, nextIn, speed: v.speed, done: nextIn === null });
}

async function eventRoutes(request, env, id, sub) {
  if (sub === 'watch' && request.method === 'POST') return watchStart(request, env, id);
  if (sub === 'script' && request.method === 'GET') return watchScript(request, env, id);
  if (sub) throw new HttpError(404, 'Not found');
  const method = request.method;
  if (method === 'GET') {
    const user = await getUser(request, env, false);
    const admin = !!(user && user.isAdmin);
    if (id) {
      const r = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
      if (!r || (!r.published && !admin)) throw new HttpError(404, 'Event not found');
      return json({ event: eventOut(r, admin) });
    }
    const q = admin ? 'SELECT * FROM events ORDER BY date DESC' : 'SELECT * FROM events WHERE published = 1 ORDER BY date DESC';
    const { results } = await env.DB.prepare(q).all();
    return json({ events: results.map(r => eventOut(r, admin)) });
  }
  const user = await getUser(request, env, true);
  if (!user.isAdmin) throw new HttpError(403, 'Only the CEO can manage events.');
  if (!id) throw new HttpError(404, 'Not found');
  if (method === 'PUT') {
    const data = cleanEvent(await readJson(request, 700 * 1024));
    await env.DB.prepare(
      `INSERT INTO events (id, title, date, published, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, date = excluded.date, published = excluded.published,
         data = excluded.data, updated_at = excluded.updated_at`)
      .bind(id, data.title, data.date, data.published ? 1 : 0, JSON.stringify(data), Date.now()).run();
    // Player submissions the CEO added to this card become "used".
    const used = [...new Set(data.segments.map(s => s.sub).filter(Boolean))];
    if (used.length) {
      await ensureSubs(env);
      await env.DB.batch(used.map(x => env.DB.prepare("UPDATE submissions SET status = 'used', used_event = ?, seen = 1, updated_at = ? WHERE id = ? AND status IN ('pending', 'approved')").bind(id, Date.now(), x)));
    }
    return json({ ok: true, id });
  }
  if (method === 'DELETE') {
    await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  throw new HttpError(405, 'Method not allowed');
}

/* ---------------- Superstar Hub: player segment submissions ---------------- */
// A player sends ideas or finished text for their wrestler; only that player and the CEO ever see them. The CEO approves,
// declines, replies, and adds approved ones to a card (which marks them used when the show is saved).
let subsReady = null;
function ensureSubs(env) {
  if (!subsReady) {
    subsReady = env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY, wrestler_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'idea',
        body TEXT NOT NULL, involved TEXT NOT NULL DEFAULT '[]', event_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
        seen INTEGER NOT NULL DEFAULT 0, ceo_note TEXT NOT NULL DEFAULT '', used_event TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_submissions_wrestler ON submissions(wrestler_id, created_at)')
    ]).catch(e => { subsReady = null; throw e; });
  }
  return subsReady;
}
const SUB_TYPES = ['promo', 'backstage', 'angle', 'other'];
const SUB_STATUS = ['pending', 'approved', 'declined', 'used'];
const MAX_OPEN_SUBS = 3, MAX_SUB_BODY = 4000;
const subOut = r => ({
  id: r.id, wrestlerId: r.wrestler_id, type: r.type, title: r.title, mode: r.mode, body: r.body,
  involved: JSON.parse(r.involved || '[]'), eventId: r.event_id, status: r.status, seen: !!r.seen,
  note: r.ceo_note, usedEvent: r.used_event, createdAt: r.created_at, updatedAt: r.updated_at
});
function cleanSub(b) {
  const type = SUB_TYPES.includes(b.type) ? b.type : null;
  if (!type) throw new HttpError(400, 'Pick what kind of segment this is.');
  const body = str(b.body, MAX_SUB_BODY);
  if (!body) throw new HttpError(400, 'Write your idea or text first.');
  return {
    type, body, title: str(b.title, 100), mode: b.mode === 'text' ? 'text' : 'idea',
    involved: [...new Set((Array.isArray(b.involved) ? b.involved : []).filter(w => typeof w === 'string' && ID_RE.test(w)))].slice(0, 6),
    eventId: typeof b.eventId === 'string' && ID_RE.test(b.eventId) ? b.eventId : ''
  };
}
async function submissionRoutes(request, env, id) {
  const user = await getUser(request, env, true);
  await ensureSubs(env);
  const method = request.method;
  if (method === 'GET' && !id) {
    const q = user.isAdmin
      ? env.DB.prepare('SELECT * FROM submissions ORDER BY created_at DESC LIMIT 300')
      : env.DB.prepare('SELECT * FROM submissions WHERE wrestler_id = ? ORDER BY created_at DESC LIMIT 100').bind(user.id);
    const { results } = await q.all();
    return json({ submissions: results.map(subOut) });
  }
  if (method === 'POST' && id === 'seen') {
    if (!user.isAdmin) throw new HttpError(403, 'Only the CEO can do that.');
    const b = await readJson(request);
    const ids = (Array.isArray(b.ids) ? b.ids : []).filter(x => typeof x === 'string' && ID_RE.test(x)).slice(0, 100);
    if (ids.length) await env.DB.batch(ids.map(x => env.DB.prepare('UPDATE submissions SET seen = 1 WHERE id = ?').bind(x)));
    return json({ ok: true });
  }
  if (method === 'POST' && !id) {
    const w = await env.DB.prepare('SELECT id FROM wrestlers WHERE id = ?').bind(user.id).first();
    if (!w) throw new HttpError(400, 'Create your wrestler first.');
    const d = cleanSub(await readJson(request));
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM submissions WHERE wrestler_id = ? AND status = 'pending'").bind(user.id).first();
    if (open && open.n >= MAX_OPEN_SUBS)
      throw new HttpError(409, `You already have ${MAX_OPEN_SUBS} submissions waiting. Wait for the CEO to respond, or withdraw one.`);
    const now = Date.now(), nid = randHex(8);
    await env.DB.prepare(
      `INSERT INTO submissions (id, wrestler_id, type, title, mode, body, involved, event_id, status, seen, ceo_note, used_event, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, '', '', ?, ?)`)
      .bind(nid, user.id, d.type, d.title, d.mode, d.body, JSON.stringify(d.involved), d.eventId, now, now).run();
    return json({ ok: true, id: nid });
  }
  if (!id) throw new HttpError(404, 'Not found');
  const row = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first();
  if (!row || (!user.isAdmin && row.wrestler_id !== user.id)) throw new HttpError(404, 'Submission not found');
  if (method === 'PUT') {
    const b = await readJson(request);
    const now = Date.now();
    if (user.isAdmin) {
      const status = SUB_STATUS.includes(b.status) ? b.status : row.status;
      const note = typeof b.note === 'string' ? str(b.note, 1000) : row.ceo_note;
      await env.DB.prepare('UPDATE submissions SET status = ?, ceo_note = ?, seen = 1, updated_at = ? WHERE id = ?').bind(status, note, now, id).run();
      return json({ ok: true, id });
    }
    if (row.status !== 'pending') throw new HttpError(409, 'The CEO has already responded to this one, so it can no longer be edited.');
    const d = cleanSub(b);
    await env.DB.prepare(
      'UPDATE submissions SET type = ?, title = ?, mode = ?, body = ?, involved = ?, event_id = ?, seen = 0, updated_at = ? WHERE id = ?')
      .bind(d.type, d.title, d.mode, d.body, JSON.stringify(d.involved), d.eventId, now, id).run();
    return json({ ok: true, id });
  }
  if (method === 'DELETE') {
    if (!user.isAdmin && row.status !== 'pending') throw new HttpError(409, 'The CEO has already responded to this one.');
    await env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  throw new HttpError(405, 'Method not allowed');
}

/* ---------------- AI writer (Google Gemini) ---------------- */

// The CEO's "Draft with AI" buttons call this. The key lives in the Worker secret GEMINI_API_KEY and never reaches the browser.
// Only ring names, styles, moves, bios, storyline facts and card details are sent to Google; never real names or accounts.
// Model ids are kept here so a changed name is a one-line fix (or set GEMINI_MODEL_MAIN / GEMINI_MODEL_LITE as variables).
const GEMINI_MODEL_MAIN = 'gemini-3.8-flash';        // intro, promos, backstage, angles, main event (about 20 free requests a day)
const GEMINI_MODEL_LITE = 'gemini-3.5-flash-lite';   // undercard matches (about 500 free requests a day)
const GEMINI_MODEL_FALLBACK = 'gemini-3.1-flash-lite'; // last resort when the others are busy or out of quota (variable GEMINI_MODEL_FALLBACK)
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const AI_CUES = ['intro_music', 'bell', 'crowd_pop', 'crowd_boo', 'crowd_chant', 'mat_slam', 'pin_count', 'chair_shot'];
const AI_SYSTEM = `You write the live text for USCW (United States Championship Wrestling), a fictional wrestling league's weekly TV show "Monday Night Mayhem" and its premium live events. Viewers read the text a few lines at a time, like a live broadcast.

THE USCW CAST (the only non-wrestler characters; use only these people, never invent other staff, officials or interviewers):
- Jason Adams is the Owner and CEO. Authoritative, brief and businesslike. He appears only in ceremonies, announcements and authority angles, or when the brief names him, and never decides anything that was not given to you.
- Cindy Maxwell is the Ring Announcer: polished and formal. She introduces each competitor before a match (hometown, and the title on the line when there is one) and announces the winner after the bell. She also reads formal announcements.
- Paul Sandler is an Interviewer: straight-laced and probing. He asks direct questions.
- Jackie O'Sullivan is an Interviewer: warm but persistent, and pushes for real answers.

VOICES (keep them identical in every segment):
- Mike Johnson is the lead play-by-play announcer: professional, precise, technical and serious. He names moves correctly, tries to stay impartial and gets exasperated with Earl.
- Earl Backwater is the color commentator: a shameless heel sympathizer. He cheers the villains, can't stand the fan favorites, makes excuses for cheating and constantly argues with Mike about which wrestlers he likes and dislikes.
- Mike and Earl are the only commentators; the cast above never does commentary.

RULES:
- Use only the facts you are given. Do not invent championships, results, injuries, family members or backstories. All wrestlers are fictional.
- Keep any outcome exactly as instructed. Never change who wins.
- Write in the present tense. Keep it PG-13: brawls, chair shots and trash talk are fine; no slurs, no real-world politics or real people other than the cast above, nothing sexual.
- Formatting inside each beat: cast and announcer lines as Mike Johnson: “...”, Earl Backwater: “...”, Cindy Maxwell: “...”, and so on; wrestler dialogue as Ring Name: “...”. Anything that describes action instead of words someone says (what the crowd or camera shows, entrances, who does what in the ring, what a wrestler does) is a beat of its own wrapped in parentheses, written in the present tense, for example (Harrison hooks the leg and drives Paco into the corner. The crowd rises as Paco fights to his feet.). A parenthesized beat may run a few sentences as long as it describes something and moves the story forward. Never mix spoken lines and parenthesized action in the same beat, and never leave action as plain unparenthesized narration.
- Each beat is one short chunk of 20 to 110 words. Reach the requested total word count within about 15 percent.
- Optional sound cue per beat, used sparingly and only when it fits: ${AI_CUES.join(', ')}, or entrance:<wrestlerId> for a wrestler's entrance (use only the ids provided). Otherwise use an empty string.
- pause is whole seconds (0 to 6) to hold after the beat; mostly 0 or 1.
Return only JSON in the requested shape.`;

const aiStr = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const aiList = (v, n, m) => (Array.isArray(v) ? v : []).slice(0, n).map(x => aiStr(x, m)).filter(Boolean);
const aiIds = v => (Array.isArray(v) ? v : []).filter(x => typeof x === 'string' && ID_RE.test(x));

function aiProfile(r, facts) {
  const w = JSON.parse(r.data), mv = w.moves || {};
  const moves = MOVE_KEYS.map(k => (Array.isArray(mv[k]) && mv[k].length ? `${MOVE_LABELS[k]}: ${mv[k].slice(0, 5).join('; ')}` : '')).filter(Boolean).join(' | ');
  const f = w.finisher || {};
  const lines = [
    `- ${w.ringName} (id: ${r.id})${w.nickname ? ` “${w.nickname}”` : ''}: ${w.alignment || 'Tweener'}, ${w.style || 'all-rounder'}, from ${w.hometown || 'parts unknown'}.`,
    w.bio ? `  Bio: ${String(w.bio).slice(0, 700)}` : '',
    f.name ? `  Finisher: ${f.name}${f.desc ? ' — ' + String(f.desc).slice(0, 300) : ''}` : '',
    moves ? `  Moves: ${moves.slice(0, 600)}` : '',
    ...(facts[r.id] || []).map(t => `  Storyline: ${t}`)
  ];
  return lines.filter(Boolean).join('\n');
}

function aiPrompt(b, profiles, nameOf) {
  const show = b.show, seg = b.segment;
  const sideNames = side => side.map(nameOf).join(' & ');
  const sidesTxt = seg.sides.filter(s => s.length).map(sideNames).join(' vs. ');
  const words = seg.length * 200;
  const head = [
    `SHOW: ${show.title || 'Monday Night Mayhem'}${show.ple ? ' (premium live event)' : ''}${show.date ? ', ' + show.date : ''}${show.venue || show.city ? ', live from ' + [show.venue, show.city].filter(Boolean).join(', ') : ''}.`,
    show.notes ? `CEO's show notes: ${show.notes}` : '',
    b.champions.length ? `CURRENT CHAMPIONS: ${b.champions.join('; ')}.` : '',
    profiles ? `WRESTLERS:\n${profiles}` : '',
    b.earlier.length ? `EARLIER IN TONIGHT'S SHOW (the announcers may refer back to these; do not retell them):\n${b.earlier.map(t => '- ' + t).join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
  let task;
  if (b.kind === 'intro') {
    const base = b.base.map((x, i) => `${i + 1}. ${x.text}`).join('\n');
    task = `TASK: Write the SHOW INTRO for tonight's broadcast, about ${words} words.
Order: (1) the show logo and theme music open the show (use the intro_music cue on that first beat); (2) the cameras pan across the crowd in the venue, vivid and specific to this venue; (3) Mike Johnson welcomes the television audience to the venue and says what a show USCW has in store, with Earl chiming in (Cindy Maxwell may add a short, formal welcome of her own); (4) Mike runs down the card, then Earl and Mike bicker briefly about who they like; (5) for each scheduled appearance, a line like "Also scheduled to be here tonight is ..." with a short blurb of that wrestler's current storyline; (6) a punchy closing line that throws to the first match.
Never reveal who wins any match tonight.
THE CARD:\n${b.card.matches.map(t => '- ' + t).join('\n') || '- (no matches announced)'}
SCHEDULED APPEARANCES:\n${b.card.appearances.map(a => `- ${a.name}: ${a.facts.join(' ')}`).join('\n') || '- (none)'}
${base ? `A plain draft already exists. Rewrite it so it reads like a real broadcast, keep every fact in it, and do not drop any match or appearance:\n${base}` : ''}`;
  } else if (b.kind === 'polish') {
    const base = b.base.map((x, i) => `${i + 1}. ${x.text}`).join('\n\n');
    task = `TASK: POLISH a ${seg.type === 'promo' ? 'promo / interview' : seg.type === 'backstage' ? 'backstage segment' : seg.type === 'angle' ? 'angle / brawl' : 'segment'} that a player wrote for their own wrestler${sidesTxt ? ` (involving ${sidesTxt})` : ''}${seg.title ? `. Title: ${seg.title}` : ''}. Rewrite it so it fits the rest of the show and reads like a real broadcast, at roughly the same length (about ${b.baseWords} words; do not pad it and do not cut it by more than a fifth).
KEEP the player's content: who says and does what, the order of events, their key lines and jokes, and how it ends. Tidy grammar, spelling and pacing. Put speech in the required format with the right ring names. Where the player wrote plain description, turn it into a parenthesized action beat. Mike Johnson and Earl Backwater may add a short setup or reaction, but never overshadow the scene. Do not add wrestlers who are not part of it, and do not change any result, who wins or loses, or any storyline fact.
Split it into beats of 20 to 110 words, and add sound cues or pauses only where they fit.
THE PLAYER'S TEXT:\n${base}`;
  } else if (seg.type === 'match') {
    const stakes = [seg.title ? `title/billing: ${seg.title}` : '', seg.stip ? `stipulation: ${seg.stip}` : ''].filter(Boolean).join('; ');
    const res = b.result;
    const outcome = res.winner >= 0 && seg.sides[res.winner]
      ? `OUTCOME (fixed, do not change): ${sideNames(seg.sides[res.winner])} ${seg.sides[res.winner].length > 1 ? 'win' : 'wins'}${res.finish ? ` — finish: ${res.finish}` : ` with their finishing move`}.`
      : 'OUTCOME (fixed): the match ends in a draw / no contest.';
    task = `TASK: Write the full MATCH segment, about ${words} words: ${sidesTxt}${stakes ? ` (${stakes})` : ''}.
Start with each competitor's entrance (use an entrance:<id> cue on a short beat for each) with Cindy Maxwell's ring introduction of that competitor (hometown, and the title on the line if any), the bell, then play-by-play and color commentary from Mike and Earl with a believable back-and-forth, the wrestlers' own moves, and the finish.
${outcome}
NEAR-FALLS (required): this match needs ${seg.length >= 10 ? 'six or more' : seg.length >= 6 ? 'four or five' : seg.length >= 4 ? 'two or three' : 'one or two'} failed finishing attempts before the end, pin attempts and submission attempts together, by BOTH wrestlers (or teams), the loser included. Build them up: early kickouts are casual and the later ones get closer, set up by a big move from that wrestler's own move list, and no two covers should be set up the same way. Unless the CEO's notes make it a squash, the eventual loser must get at least one or two close pin attempts of their own.
Write every PIN ATTEMPT as exactly three beats in a row:
 1. a short beat from Mike (Earl may add a line) calling the cover, for example: Mike Johnson: “Hardbody Harrison hooks the leg and goes for the cover…”
 2. a COUNT BEAT whose text is ONLY the numbers and nothing else: write 1 2 for a kickout. The show page draws and times it (one second per number), so never add dots, words or punctuation to a count beat, and use no cue or pause on it.
 3. the kickout beat, shown right after the 2, for example: Mike Johnson: “NO! Paco gets the shoulder up at the last possible moment!” with Earl reacting (he complains about the count when his favorite is the one covering, or cheers when a favorite he dislikes is almost beaten).
The final pinfall is the same, except its count beat is 1 2 3 and the next beat is the bell and Cindy's announcement. Never let a count beat reach 3 unless that pin ends the match.
SUBMISSION FINISHERS: if a wrestler's finisher is a submission hold (judge by its name and description), and he is set to lose, he locks it in at least once during the match and his opponent escapes, counters it, or reaches the ropes. For a rope break use a count beat of 1 2 3 4 (the ref counting to four), then the ref breaking the hold and the crowd reacting. If he is set to win by that submission, the earlier attempts fail the same way, and the final one makes the opponent tap out or pass out with no count beat.
After the finish, Cindy Maxwell announces the winner (and any title change).
${seg.desc ? `CEO notes / story for this match: ${seg.desc}` : ''}`;
  } else {
    task = `TASK: Write this ${seg.type === 'promo' ? 'PROMO / INTERVIEW' : seg.type === 'backstage' ? 'BACKSTAGE SEGMENT' : seg.type === 'angle' ? 'ANGLE / BRAWL' : seg.type === 'ceremony' ? 'CEREMONY / ANNOUNCEMENT' : 'SEGMENT'}, about ${words} words${sidesTxt ? `, involving ${sidesTxt}` : ''}${seg.title ? `. Title: ${seg.title}` : ''}.
Mike and Earl may set it up and react afterwards. Wrestlers speak in character, using their alignment and storylines.
${['promo', 'backstage'].includes(seg.type) ? 'Run it through one of the interviewers, Paul Sandler or Jackie O\'Sullivan (alternate between them, or use the one the brief names): they ask the questions and set up the wrestler\'s answers.' : ''}
${seg.type === 'ceremony' ? 'Cindy Maxwell reads any formal announcement, and Jason Adams may speak if it fits.' : ''}${seg.type === 'angle' ? 'Jason Adams may step in to restore order only if the brief says so.' : ''}
${seg.desc ? `CEO's brief (follow it; if it contains actual dialogue or text from a player, keep that wording as much as possible): ${seg.desc}` : 'No brief was given: build the scene from the storylines above.'}`;
  }
  return `${head}\n\n${task}`;
}

async function geminiCall(env, model, system, prompt, words, timeoutMs = 50000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${env.GEMINI_BASE_URL || GEMINI_BASE}${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.9,
          maxOutputTokens: Math.min(16000, Math.round(words * 3) + 2500),
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: { beats: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
              text: { type: 'STRING' }, cue: { type: 'STRING' }, pause: { type: 'INTEGER' } }, required: ['text'] } } },
            required: ['beats']
          }
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
        ]
      })
    });
  } catch (e) {
    const to = !!(e && e.name === 'AbortError');
    throw Object.assign(new Error(to ? 'Gemini took too long to answer.' : 'Could not reach Gemini.'), { kind: 'upstream', code: to ? 'timeout' : 'network' });
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const kind = res.status === 429 ? 'quota' : (res.status === 404 || res.status === 400) ? 'model' : (res.status === 401 || res.status === 403) ? 'auth' : 'upstream';
    let detail = ''; try { detail = (await res.json()).error.message || ''; } catch (_) { /* no body */ }
    console.error('gemini', model, res.status, detail.slice(0, 300));
    throw Object.assign(new Error(`Gemini (${model}) answered ${res.status}.`), { kind, code: res.status });
  }
  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  const text = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts.map(p => p.text || '').join('') : '';
  if (!text) throw Object.assign(new Error('Gemini declined to write this one. Try changing the brief, then draft again.'), { kind: 'blocked', code: 'blocked' });
  let parsed;
  try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch (_) { parsed = null; }
  const beats = parsed && Array.isArray(parsed.beats) ? parsed.beats : null;
  if (!beats) throw Object.assign(new Error('Gemini’s reply could not be read. Please try again.'), { kind: 'badreply', code: 'badreply' });
  return beats;
}

async function aiDraft(request, env) {
  const user = await getUser(request, env, true);
  if (!user.isAdmin) throw new HttpError(403, 'Only the CEO can use the AI writer.');
  if (!env.GEMINI_API_KEY) throw new HttpError(503, 'The Gemini key is not set on the Worker yet (secret GEMINI_API_KEY).');
  const raw = await readJson(request, 120 * 1024);
  const s = raw.segment && typeof raw.segment === 'object' ? raw.segment : {};
  const type = SEG_TYPES.includes(s.type) ? s.type : 'other';
  const kind = raw.kind === 'intro' ? 'intro' : raw.kind === 'polish' ? 'polish' : 'segment';
  const sh = raw.show && typeof raw.show === 'object' ? raw.show : {};
  const res = raw.result && typeof raw.result === 'object' ? raw.result : {};
  const card = raw.card && typeof raw.card === 'object' ? raw.card : {};
  const sides = (Array.isArray(s.sides) ? s.sides : []).slice(0, 8).map(a => aiIds(a).slice(0, 8));
  const facts = {};
  if (raw.facts && typeof raw.facts === 'object') for (const [k, v] of Object.entries(raw.facts)) if (ID_RE.test(k)) facts[k] = aiList(v, 6, 400);
  const ids = [...new Set([...sides.flat(), ...aiIds(raw.wrestlers)])].slice(0, 24);
  const b = {
    kind, tier: raw.tier === 'lite' ? 'lite' : 'main',
    show: { title: aiStr(sh.title, 100), date: aiStr(sh.date, 10), venue: aiStr(sh.venue, 100), city: aiStr(sh.city, 100), ple: !!sh.ple, notes: aiStr(sh.notes, 600) },
    segment: { type, title: aiStr(s.title, 100), stip: aiStr(s.stip, 100), desc: aiStr(s.desc, 2000), length: cleanLength(s.length, type), sides },
    result: { winner: Number.isInteger(res.winner) && res.winner >= -1 && res.winner < sides.length ? res.winner : -1, finish: aiStr(res.finish, 300) },
    earlier: aiList(raw.earlier, 14, 300), champions: aiList(raw.champions, 6, 200),
    base: (Array.isArray(raw.base) ? raw.base : []).slice(0, 40).map(x => ({ text: aiStr(x && x.text, 1200) })).filter(x => x.text),
    baseWords: 0,
    card: {
      matches: aiList(card.matches, 12, 400),
      appearances: (Array.isArray(card.appearances) ? card.appearances : []).slice(0, 12)
        .map(a => ({ name: aiStr(a && a.name, 80), facts: aiList(a && a.facts, 6, 400) })).filter(a => a.name)
    }
  };
  b.baseWords = b.base.reduce((n, x) => n + x.text.split(/\s+/).filter(Boolean).length, 0);
  if (kind === 'polish' && !b.baseWords) throw new HttpError(400, 'There is no text to polish.');
  if (type === 'match' && kind === 'segment' && sides.filter(x => x.length).length < 2) throw new HttpError(400, 'Add the wrestlers to the match first.');
  let rows = [];
  if (ids.length) {
    const q = await env.DB.prepare(`SELECT id, data FROM wrestlers WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    rows = q.results || [];
  }
  const names = {}; for (const r of rows) { try { names[r.id] = JSON.parse(r.data).ringName; } catch (_) { /* skip */ } }
  const nameOf = id => names[id] || 'Unknown Wrestler';
  const profiles = rows.map(r => { try { return aiProfile(r, facts); } catch (_) { return ''; } }).filter(Boolean).join('\n');
  const prompt = aiPrompt(b, profiles, nameOf);
  const words = kind === 'polish' ? Math.max(120, b.baseWords) : b.segment.length * 200;
  const mainModel = env.GEMINI_MODEL_MAIN || GEMINI_MODEL_MAIN, liteModel = env.GEMINI_MODEL_LITE || GEMINI_MODEL_LITE, backupModel = env.GEMINI_MODEL_FALLBACK || GEMINI_MODEL_FALLBACK;
  // Cheaper calls: lite, then 3.1, then the stronger model. Stronger calls: stronger, then lite, then 3.1.
  const chain = [...new Set(b.tier === 'lite' ? [liteModel, backupModel, mainModel] : [mainModel, liteModel, backupModel])];
  const t0 = Date.now(), tried = [];
  let model = chain[0], beats = null, lastErr = null;
  const why = c => c === 503 ? 'busy (503)' : c === 429 ? 'rate or daily limit reached (429)' : c === 404 ? 'model name not found (404)' : c === 400 ? 'request rejected (400)'
    : c === 401 || c === 403 ? `key not accepted (${c})` : typeof c === 'number' ? `server error (${c})` : c === 'timeout' ? 'timed out' : c === 'network' ? 'could not be reached'
    : c === 'blocked' ? 'declined to write it' : c === 'badreply' ? 'sent an unreadable reply' : 'failed';
  const short = m => String(m).replace(/^gemini-/, '');
  outer:
  for (let i = 0; i < chain.length && !beats; i++) {
    for (let attempt = 0; attempt < 2 && !beats; attempt++) {
      const left = 100000 - (Date.now() - t0);
      if (left < 8000) break outer;   // out of time: stop and report what happened
      model = chain[i];
      try {
        beats = await geminiCall(env, model, AI_SYSTEM, prompt, words, Math.min(50000, left));
      } catch (e) {
        lastErr = e;
        const retried = attempt === 0 && e.kind === 'upstream' && e.code !== 'timeout';
        tried.push([short(model), why(e.code)]);
        if (retried) { await new Promise(r => setTimeout(r, 2000)); continue; }
        if (e.kind === 'blocked' || e.kind === 'auth') break outer;  // would fail the same way everywhere
        break;  // quota, bad model name, timeout, unreadable reply: next model
      }
    }
  }
  if (!beats) {
    const byModel = new Map();
    for (const [m, w] of tried) byModel.set(m, [...(byModel.get(m) || []), w]);
    const trail = tried.length ? [...byModel].map(([m, ws]) => `${m}: ${ws.every(x => x === ws[0]) ? ws[0] + (ws.length > 1 ? ' twice' : '') : ws.join(', then ')}`).join(' · ') : 'no model could be tried in time';
    console.error('gemini chain failed', trail);
    if (lastErr && lastErr.kind === 'blocked') throw aiFail(lastErr);
    if (lastErr && lastErr.kind === 'auth') throw new HttpError(502, `Gemini did not accept the API key (${trail}). Check the GEMINI_API_KEY secret and that the key may use these models.`);
    const allQuota = tried.length > 0 && tried.every(t => /limit reached/.test(t[1]));
    throw new HttpError(allQuota ? 429 : 503, `Gemini could not write this. ${trail}. ${allQuota ? 'Try again later (daily limits reset at midnight Pacific).' : 'Try again in a minute.'}`);
  }
  const fellBack = model !== chain[0];
  const ok = new Set(ids);
  const out = cleanBeats(beats.map(x => {
    x = x && typeof x === 'object' ? x : {};
    const cue = typeof x.cue === 'string' ? x.cue.trim() : '';
    const good = AI_CUES.includes(cue) || (cue.startsWith('entrance:') && ok.has(cue.slice(9)));
    return { text: aiAction(x.text), pause: Math.min(6, Number(x.pause) || 0), cue: good ? cue : '' };
  }));
  if (!out.length) throw new HttpError(502, 'Gemini’s reply was empty. Please try again.');
  return json({ ok: true, beats: out, model, fellBack });
}
// Action beats must be in parentheses. Dialogue (Name: “...”) and pin counts (1 2) are left alone.
function aiAction(t) {
  t = typeof t === 'string' ? t.trim() : '';
  if (!t || /^[\s.1-4]+$/.test(t) && /[1-4]/.test(t)) return t;
  if (/^\(/.test(t) && /\)$/.test(t)) return t;
  if (/^[A-Z][\w'.\-]*(\s+[A-Z][\w'.\-]*){0,3}:\s*\S/.test(t)) return t;   // a speaker's name, then the line
  return '(' + t + ')';
}
function aiFail(e) {
  if (e instanceof HttpError) return e;
  const msg = e.kind === 'quota' ? 'Gemini’s free daily limit has been reached. Try again later (the quota resets at midnight Pacific).'
    : e.kind === 'model' ? (e.message + ' Check the model name in the Worker settings.') : e.message || 'The AI writer failed.';
  return new HttpError(e.kind === 'quota' ? 429 : 502, msg);
}

/* ---------------- championships ---------------- */

const champOut = r => ({ id: r.id, name: r.name, kind: r.kind, holders: JSON.parse(r.holders || '[]'), since: r.since, wonAt: r.won_at });

async function championshipRoutes(request, env, id) {
  const method = request.method;
  if (method === 'GET' && !id) {
    const { results } = await env.DB.prepare('SELECT * FROM championships ORDER BY sort, name').all();
    return json({ championships: results.map(champOut) });
  }
  if (method === 'PUT' && id) {
    const user = await getUser(request, env, true);
    if (!user.isAdmin) throw new HttpError(403, 'Only the CEO can award championships.');
    const title = await env.DB.prepare('SELECT * FROM championships WHERE id = ?').bind(id).first();
    if (!title) throw new HttpError(404, 'Championship not found');
    const b = await readJson(request);
    const holders = [...new Set((Array.isArray(b.holders) ? b.holders : []).filter(w => typeof w === 'string' && ID_RE.test(w)))];
    const max = title.kind === 'tag' ? 2 : 1;
    if (holders.length > max) throw new HttpError(400, title.kind === 'tag' ? 'A tag team title has two champions.' : 'A singles title has one champion.');
    if (title.kind === 'tag' && holders.length === 1) throw new HttpError(400, 'A tag team title needs two wrestlers (or leave it vacant).');
    if (holders.length) {
      const marks = holders.map(() => '?').join(',');
      const { results } = await env.DB.prepare(`SELECT id FROM wrestlers WHERE id IN (${marks})`).bind(...holders).all();
      if (results.length !== holders.length) throw new HttpError(400, 'Champion must be someone on the roster.');
    }
    const since = holders.length && /^\d{4}-\d{2}-\d{2}$/.test(str(b.since, 10)) ? str(b.since, 10) : '';
    const wonAt = holders.length ? str(b.wonAt, 100) : '';
    await env.DB.prepare('UPDATE championships SET holders = ?, since = ?, won_at = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(holders), since, wonAt, Date.now(), id).run();
    return json({ ok: true, id });
  }
  throw new HttpError(405, 'Method not allowed');
}

/* ---------------- router ---------------- */
async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const m = request.method;

  if (path === '/api/health') return json({ ok: true });
  if (m === 'POST') {
    if (path === '/api/register') return register(request, env);
    if (path === '/api/resend-verification') return resendVerification(request, env);
    if (path === '/api/verify') return verifyEmail(request, env);
    if (path === '/api/login') return login(request, env);
    if (path === '/api/logout') return logout(request, env);
    if (path === '/api/forgot') return forgot(request, env);
    if (path === '/api/reset') return resetPassword(request, env);
  }
  if (m === 'GET' && path === '/api/me') return json({ user: publicUser(await getUser(request, env, true)) });

  if (m === 'POST' && path === '/api/ai/draft') return aiDraft(request, env);
  const bm = path.match(/^\/api\/submissions(?:\/([A-Za-z0-9_-]{1,64}))?$/);
  if (bm) return submissionRoutes(request, env, bm[1]);
  const sm = path.match(/^\/api\/story(?:\/([A-Za-z0-9_-]{1,64}))?$/);
  if (sm) return storyRoutes(request, env, sm[1]);

  const r = path.match(/^\/api\/(wrestlers|events|championships)(?:\/([A-Za-z0-9_-]{1,64}))?(?:\/(watch|script))?$/);
  if (r) {
    if (r[3] && r[1] !== 'events') throw new HttpError(404, 'Not found');
    if (r[1] === 'wrestlers') return wrestlerRoutes(request, env, r[2]);
    if (r[1] === 'events') return eventRoutes(request, env, r[2], r[3]);
    return championshipRoutes(request, env, r[2]);
  }
  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request.headers.get('Origin'), env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await route(request, env);
    } catch (e) {
      if (e instanceof HttpError) res = json({ error: e.message, code: e.code }, e.status);
      else { console.error(e); res = json({ error: 'Server error. Please try again.' }, 500); }
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  }
};
