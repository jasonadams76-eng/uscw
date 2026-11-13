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
    const stmts = [env.DB.prepare('DELETE FROM wrestlers WHERE id = ?').bind(id)];
    for (const t of titles) {
      if (JSON.parse(t.holders || '[]').includes(id))   // a released champion leaves the title vacant
        stmts.push(env.DB.prepare("UPDATE championships SET holders = '[]', since = '', won_at = '', updated_at = ? WHERE id = ?").bind(Date.now(), t.id));
    }
    await env.DB.batch(stmts);
    return json({ ok: true });
  }
  throw new HttpError(405, 'Method not allowed');
}

/* ---------------- events ---------------- */
const SEG_TYPES = ['match', 'promo', 'backstage', 'angle', 'ceremony', 'other'];
// Sound cues the show script may trigger (the audio files themselves are added later).
const CUE_RE = /^(bell|crowd_pop|crowd_boo|crowd_chant|mat_slam|pin_count|chair_shot|entrance:[A-Za-z0-9_-]{1,40})$/;
const MAX_BEATS = 120, MAX_BEAT_CHARS = 1200, MAX_SCRIPT_CHARS = 150000;
const cleanLength = (v, type) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(30, n) : (type === 'match' ? 6 : 3);
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
      beats: cleanBeats(s.beats)
    };
  });
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
      .map(({ beats, ...s }) => ({ ...s, scripted: Array.isArray(beats) && beats.length > 0 }));
  }
  return e;
};

/* ---------------- live show script ---------------- */
// Viewers start the show themselves. The Worker only hands out text once enough time has passed since they pressed
// Start, so nobody can read ahead. Pacing comes from the text itself (about 150 words a minute) plus the CEO's pauses.
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
const REVEAL_WPS = 2.5, SEG_GAP = 4;
function buildTimeline(data) {
  const beats = []; let t = 0, first = true;
  for (const s of data.segments || []) {
    const list = (s.beats || []).filter(b => b.text || b.cue);
    if (!list.length) continue;
    if (!first) t += SEG_GAP;
    first = false;
    list.forEach((b, j) => {
      const words = (b.text.match(/\S+/g) || []).length;
      const dur = Math.max(1.5, words / REVEAL_WPS) + (b.pause || 0);
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
    return json({ ok: true, id });
  }
  if (method === 'DELETE') {
    await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  throw new HttpError(405, 'Method not allowed');
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
