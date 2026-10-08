// AI活用ライブラリーのサーバー側（Cloudflare Pages Functions + D1）
// 必要な設定：D1データベースを「DB」という名前で紐づける／環境変数 SETUP_KEY（最初の経営サイドアカウント作成用）

const SESSION_DAYS = 30;
const MAX_FAILED = 10;
const LOCK_MINUTES = 15;
const MAX_PHOTO_CHARS = 1500000;
const ROLES = ['admin', 'manager', 'staff'];
const REACTIONS = ['like', 'tried', 'mimic'];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, login_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL, store_id TEXT, pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, category_id TEXT NOT NULL, store_id TEXT, author_id TEXT, want TEXT, cant TEXT, why TEXT, result TEXT, fix TEXT, prompt TEXT, pinned INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0, is_sample INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reactions (post_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (post_id, user_id, type))`,
  `CREATE TABLE IF NOT EXISTS saves (user_id TEXT NOT NULL, post_id TEXT NOT NULL, PRIMARY KEY (user_id, post_id))`,
  `CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, user_id TEXT, text TEXT NOT NULL, answer_text TEXT, answered_at INTEGER, created_at INTEGER NOT NULL)`
];

let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map(sql => db.prepare(sql)));
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM stores').first();
  if (n === 0) await seed(db);
  schemaReady = true;
}

async function seed(db) {
  const now = Date.now();
  const day = 86400000;
  const stores = [['shibuya', '渋谷店'], ['shinjuku', '新宿店'], ['ikebukuro', '池袋店']];
  const cats = [['c-kuchikomi', 'クチコミ返信'], ['c-kaigi', '会議のアジェンダ作り'], ['c-shift', 'シフト作成'], ['c-hacchu', '発注'], ['c-shinjin', '新人教育'], ['c-mail', 'メール/お知らせ作成']];
  const posts = [
    ['低評価のクチコミに返す文の下書きを作る', 'c-kuchikomi', 'shibuya', '低い評価のクチコミに、その日のうちに返信したかった。', '文章を考えるのに時間がかかり、返信が翌日以降になっていた。', 'お詫びの言い方に迷い、毎回ゼロから書いていた。', '下書きが数十秒で出てきて、直しだけで返信できた。', '店名と状況を先に書いてから頼むと、そのまま使える文になる。', 'あなたは飲食店の店長です。次のクチコミに、お詫びと改善の予定を入れて150字程度で返信してください。／クチコミ：（貼り付け）', 1, 1],
    ['発注量の目安を前年と天気から出す', 'c-hacchu', 'shinjuku', '発注量を毎回の勘ではなく目安をもとに決めたかった。', '前年の数字と天気を見比べる時間が取れなかった。', '表計算を毎週手作業でまとめ直していた。', '前年実績と天気予報を渡すと、増減の目安を出してくれた。', '前年の数字と週間天気をまとめて渡すと精度が上がる。', 'あなたは飲食店の発注担当です。前年の同時期の発注数と今週の天気予報を渡すので、今週の発注量の目安を教えてください。／前年実績：（貼り付け）／天気：（貼り付け）', 0, 4],
    ['希望シフトの整理をまとめて頼む', 'c-shift', 'ikebukuro', 'バラバラに届く希望シフトを一つの表にまとめたかった。', '手作業で表に転記するのに毎回時間がかかっていた。', '人によって書き方や連絡手段が違っていた。', '箇条書きを渡すだけで、表の形に整理してくれた。', '誰の希望かを先頭に書いてもらうと整理しやすい。', '次の希望シフトの一覧を、日付ごとの表に整理してください。／希望一覧：（貼り付け）', 0, 6],
    ['新人が最初の3日で覚えることを整理する', 'c-shinjin', 'shibuya', '新人研修の初日〜3日目の内容を整理したかった。', '教える内容が人によってバラバラになっていた。', '研修の流れを文書にする時間がなかった。', '3日分のチェックリストのたたき台がすぐできた。', '店の営業時間や役割分担も先に伝えるとより合う内容になる。', '飲食店の新人アルバイトが最初の3日間で覚えることを、日ごとのチェックリストにしてください。', 0, 9],
    ['全店へのお知らせ文を店ごとに書き分ける', 'c-mail', null, '全店共通のお知らせを、店舗ごとの事情に合わせて出したかった。', '店舗数ぶん書き直すのに時間がかかっていた。', '共通部分と店舗ごとの違いを毎回考え直していた。', '共通文と店舗名を渡すだけで店舗別に書き分けてくれた。', '共通で伝えたいことを先に箇条書きにしておくとよい。', '次のお知らせ内容を、渋谷店・新宿店・池袋店それぞれ向けに、店名を入れて書き分けてください。／お知らせ内容：（貼り付け）', 0, 11]
  ];
  const stmts = [];
  stores.forEach(([id, name], i) => stmts.push(db.prepare('INSERT INTO stores (id, name, sort) VALUES (?, ?, ?)').bind(id, name, i)));
  cats.forEach(([id, name], i) => stmts.push(db.prepare('INSERT INTO categories (id, name, created_at) VALUES (?, ?, ?)').bind(id, name, now - 30 * day + i)));
  posts.forEach(p => {
    const at = now - p[10] * day;
    stmts.push(db.prepare('INSERT INTO posts (id, title, category_id, store_id, author_id, want, cant, why, result, fix, prompt, pinned, views, is_sample, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)')
      .bind(newId(), p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], at, at));
  });
  await db.batch(stmts);
}

/* ---------- 共通 ---------- */

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Date.now().toString(36) + Array.from(b, x => x.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toB64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function fromB64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

async function sha256(text) {
  return toB64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

async function hashPassword(password, saltB64) {
  const salt = saltB64 ? fromB64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return { hash: toB64(bits), salt: toB64(salt) };
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function str(v, max, label, required = true) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) fail(400, label + 'を入力してください');
  if (s.length > max) fail(400, label + 'は' + max + '文字以内にしてください');
  return s;
}

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) fail(400, 'パスワードは8文字以上にしてください');
  if (pw.length > 128) fail(400, 'パスワードが長すぎます');
  return pw;
}

function checkLoginId(v) {
  const s = str(v, 40, 'ID');
  if (!/^[A-Za-z0-9._-]+$/.test(s)) fail(400, 'IDは半角英数字と . _ - だけで入力してください');
  return s;
}

function sessionCookie(token, maxAge) {
  return `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function readCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

async function currentUser(db, request) {
  const token = readCookie(request, 'sid');
  if (!token) return null;
  const row = await db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1')
    .bind(await sha256(token), Date.now()).first();
  return row || null;
}

async function createSession(db, userId) {
  const token = randomToken();
  await db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), userId, Date.now() + SESSION_DAYS * 86400000).run();
  return sessionCookie(token, SESSION_DAYS * 86400);
}

/* ---------- データの読み出し ---------- */

async function loadAll(db, me) {
  const [stores, cats, users, posts, photos, reactions, saves, questions] = await db.batch([
    db.prepare('SELECT id, name FROM stores ORDER BY sort, name'),
    db.prepare('SELECT id, name FROM categories ORDER BY created_at'),
    db.prepare('SELECT id, name, role, store_id, active FROM users'),
    db.prepare('SELECT * FROM posts ORDER BY created_at DESC'),
    db.prepare('SELECT id, post_id FROM photos ORDER BY idx'),
    db.prepare('SELECT post_id, user_id, type FROM reactions'),
    db.prepare('SELECT post_id FROM saves WHERE user_id = ?').bind(me.id),
    db.prepare('SELECT * FROM questions ORDER BY created_at')
  ]);
  const byPost = {};
  const postList = posts.results.map(p => {
    const o = {
      id: p.id, title: p.title, categoryId: p.category_id, storeId: p.store_id, authorId: p.author_id,
      steps: { want: p.want || '', cant: p.cant || '', why: p.why || '', result: p.result || '', fix: p.fix || '' },
      prompt: p.prompt || '', photos: [], reactions: { like: [], tried: [], mimic: [] },
      views: p.views, pinned: !!p.pinned, isSample: !!p.is_sample, createdAt: p.created_at, questions: []
    };
    byPost[p.id] = o;
    return o;
  });
  photos.results.forEach(ph => byPost[ph.post_id] && byPost[ph.post_id].photos.push('/api/photos/' + ph.id));
  reactions.results.forEach(r => byPost[r.post_id] && byPost[r.post_id].reactions[r.type] && byPost[r.post_id].reactions[r.type].push(r.user_id));
  questions.results.forEach(q => byPost[q.post_id] && byPost[q.post_id].questions.push({
    id: q.id, userId: q.user_id, text: q.text, at: q.created_at,
    answer: q.answer_text ? { text: q.answer_text, at: q.answered_at } : null
  }));
  return {
    me: { id: me.id, loginId: me.login_id, name: me.name, role: me.role, storeId: me.store_id, mustChange: !!me.must_change },
    lastSeen: me.last_seen,
    stores: stores.results,
    categories: cats.results,
    accounts: users.results.map(u => ({ id: u.id, name: u.name, role: u.role, storeId: u.store_id, active: !!u.active })),
    posts: postList,
    saved: saves.results.map(s => s.post_id)
  };
}

/* ---------- 投稿 ---------- */

async function getPost(db, id) {
  const post = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  if (!post) fail(404, '投稿が見つかりません');
  return post;
}

function canEdit(me, post) { return me.role === 'admin' || post.author_id === me.id; }

async function readPostBody(db, body) {
  const title = str(body.title, 100, 'タイトル');
  const categoryId = str(body.categoryId, 64, 'カテゴリ');
  if (!(await db.prepare('SELECT id FROM categories WHERE id = ?').bind(categoryId).first())) fail(400, 'カテゴリが見つかりません');
  const s = body.steps || {};
  const steps = {};
  for (const k of ['want', 'cant', 'why', 'result', 'fix']) steps[k] = str(s[k], 2000, '5項目', false);
  const prompt = str(body.prompt, 5000, 'プロンプト', false);
  const photos = Array.isArray(body.photos) ? body.photos.slice(0, 3) : [];
  for (const p of photos) {
    if (typeof p !== 'string') fail(400, '写真の形式が正しくありません');
    if (p.startsWith('/api/photos/')) continue;
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p)) fail(400, '写真の形式が正しくありません');
    if (p.length > MAX_PHOTO_CHARS) fail(400, '写真のサイズが大きすぎます');
  }
  return { title, categoryId, steps, prompt, photos };
}

function photoStatements(db, postId, photos, keepIds) {
  const stmts = [];
  photos.forEach((p, i) => {
    if (p.startsWith('/api/photos/')) {
      const id = p.slice('/api/photos/'.length);
      if (keepIds.has(id)) stmts.push(db.prepare('UPDATE photos SET idx = ? WHERE id = ? AND post_id = ?').bind(i, id, postId));
    } else {
      stmts.push(db.prepare('INSERT INTO photos (id, post_id, idx, data) VALUES (?, ?, ?, ?)').bind(newId(), postId, i, p));
    }
  });
  return stmts;
}

/* ---------- ルーティング ---------- */

async function handle(request, env) {
  const db = env.DB;
  if (!db) fail(500, 'データベースが設定されていません');
  await ensureSchema(db);

  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = request.method;
  // 例：/api/posts/abc/react → 'POST /posts/:id/react'、/api/admin/users/abc → 'PUT /admin/users/:id'
  const idPos = parts[0] === 'admin' ? 2 : 1;
  const route = method + ' /' + parts.map((p, i) => (i === idPos ? ':id' : p)).join('/');
  const id = parts[idPos];

  let body = {};
  if (method !== 'GET') {
    if (!(request.headers.get('Content-Type') || '').includes('application/json')) fail(415, '送信形式が正しくありません');
    body = await request.json().catch(() => ({}));
  }

  /* ログイン前に使えるもの */
  if (route === 'GET /status') {
    const { n } = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
    return json({ setupNeeded: n === 0 });
  }

  if (route === 'POST /setup') {
    const { n } = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
    if (n > 0) fail(403, '初期設定はすでに完了しています');
    if (!env.SETUP_KEY || typeof body.setupKey !== 'string' || !safeEqual(body.setupKey.trim(), env.SETUP_KEY)) fail(403, '初期設定キーが違います');
    const loginId = checkLoginId(body.loginId);
    const name = str(body.name, 40, '名前');
    const { hash, salt } = await hashPassword(checkPassword(body.password));
    const uid = newId();
    await db.prepare('INSERT INTO users (id, login_id, name, role, store_id, pw_hash, pw_salt, must_change, created_at) VALUES (?, ?, ?, \'admin\', NULL, ?, ?, 0, ?)')
      .bind(uid, loginId, name, hash, salt, Date.now()).run();
    return json({ ok: true }, 200, { 'Set-Cookie': await createSession(db, uid) });
  }

  if (route === 'POST /login') {
    const loginId = str(body.loginId, 40, 'ID');
    const password = typeof body.password === 'string' ? body.password : '';
    const user = await db.prepare('SELECT * FROM users WHERE login_id = ?').bind(loginId).first();
    const now = Date.now();
    if (user && user.locked_until > now) fail(429, 'ログインの失敗が続いたため、しばらくログインできません。' + LOCK_MINUTES + '分ほど待ってからお試しください');
    const { hash } = await hashPassword(password, user ? user.pw_salt : undefined);
    const ok = user && user.active && safeEqual(hash, user.pw_hash);
    if (!ok) {
      if (user) {
        const failed = user.failed + 1;
        await db.prepare('UPDATE users SET failed = ?, locked_until = ? WHERE id = ?')
          .bind(failed >= MAX_FAILED ? 0 : failed, failed >= MAX_FAILED ? now + LOCK_MINUTES * 60000 : 0, user.id).run();
      }
      fail(401, 'IDまたはパスワードが違います');
    }
    await db.batch([
      db.prepare('UPDATE users SET failed = 0, locked_until = 0 WHERE id = ?').bind(user.id),
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now)
    ]);
    return json({ ok: true }, 200, { 'Set-Cookie': await createSession(db, user.id) });
  }

  if (route === 'POST /logout') {
    const token = readCookie(request, 'sid');
    if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (route === 'GET /photos/:id') {
    if (!(await currentUser(db, request))) fail(401, 'ログインしてください');
    const row = await db.prepare('SELECT data FROM photos WHERE id = ?').bind(id).first();
    if (!row) fail(404, '写真が見つかりません');
    const m = row.data.match(/^data:(image\/[a-z]+);base64,(.*)$/);
    return new Response(fromB64(m[2]), { headers: { 'Content-Type': m[1], 'Cache-Control': 'private, max-age=31536000, immutable' } });
  }

  /* ここから先はログインが必要 */
  const me = await currentUser(db, request);
  if (!me) fail(401, 'ログインしてください');

  if (route === 'POST /password') {
    if (!safeEqual((await hashPassword(typeof body.current === 'string' ? body.current : '', me.pw_salt)).hash, me.pw_hash)) fail(400, '今のパスワードが違います');
    const next = checkPassword(body.next);
    if (next === body.current) fail(400, '今と違うパスワードにしてください');
    const { hash, salt } = await hashPassword(next);
    const token = readCookie(request, 'sid');
    await db.batch([
      db.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, must_change = 0 WHERE id = ?').bind(hash, salt, me.id),
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(me.id, await sha256(token))
    ]);
    return json({ ok: true });
  }

  if (me.must_change && route !== 'GET /data') fail(403, '先にパスワードを変更してください');

  switch (route) {
    case 'GET /data':
      return json(await loadAll(db, me));

    case 'POST /seen':
      await db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(Date.now(), me.id).run();
      return json({ ok: true });

    case 'POST /posts': {
      if (me.role === 'staff') fail(403, '投稿できるのは経営サイドと店長だけです');
      const b = await readPostBody(db, body);
      const pid = newId();
      const now = Date.now();
      await db.batch([
        db.prepare('INSERT INTO posts (id, title, category_id, store_id, author_id, want, cant, why, result, fix, prompt, pinned, views, is_sample, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)')
          .bind(pid, b.title, b.categoryId, me.store_id, me.id, b.steps.want, b.steps.cant, b.steps.why, b.steps.result, b.steps.fix, b.prompt, me.role === 'admin' && body.pinned ? 1 : 0, now, now),
        ...photoStatements(db, pid, b.photos.filter(p => !p.startsWith('/api/photos/')), new Set())
      ]);
      return json({ ok: true, id: pid });
    }

    case 'PUT /posts/:id': {
      const post = await getPost(db, id);
      if (!canEdit(me, post)) fail(403, 'この投稿は編集できません');
      const b = await readPostBody(db, body);
      const current = (await db.prepare('SELECT id FROM photos WHERE post_id = ?').bind(id).all()).results.map(r => r.id);
      const keep = new Set(b.photos.filter(p => p.startsWith('/api/photos/')).map(p => p.slice('/api/photos/'.length)).filter(x => current.includes(x)));
      const pinned = me.role === 'admin' ? (body.pinned ? 1 : 0) : post.pinned;
      await db.batch([
        db.prepare('UPDATE posts SET title = ?, category_id = ?, want = ?, cant = ?, why = ?, result = ?, fix = ?, prompt = ?, pinned = ?, updated_at = ? WHERE id = ?')
          .bind(b.title, b.categoryId, b.steps.want, b.steps.cant, b.steps.why, b.steps.result, b.steps.fix, b.prompt, pinned, Date.now(), id),
        ...current.filter(x => !keep.has(x)).map(x => db.prepare('DELETE FROM photos WHERE id = ?').bind(x)),
        ...photoStatements(db, id, b.photos, keep)
      ]);
      return json({ ok: true });
    }

    case 'DELETE /posts/:id': {
      const post = await getPost(db, id);
      if (!canEdit(me, post)) fail(403, 'この投稿は削除できません');
      await db.batch(['posts WHERE id', 'photos WHERE post_id', 'reactions WHERE post_id', 'saves WHERE post_id', 'questions WHERE post_id']
        .map(t => db.prepare('DELETE FROM ' + t + ' = ?').bind(id)));
      return json({ ok: true });
    }

    case 'POST /posts/:id/view':
      await db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').bind(id).run();
      return json({ ok: true });

    case 'POST /posts/:id/react': {
      if (!REACTIONS.includes(body.type)) fail(400, 'リアクションの種類が正しくありません');
      await getPost(db, id);
      const exists = await db.prepare('SELECT 1 FROM reactions WHERE post_id = ? AND user_id = ? AND type = ?').bind(id, me.id, body.type).first();
      await db.prepare(exists ? 'DELETE FROM reactions WHERE post_id = ? AND user_id = ? AND type = ?' : 'INSERT INTO reactions (post_id, user_id, type) VALUES (?, ?, ?)')
        .bind(id, me.id, body.type).run();
      return json({ ok: true });
    }

    case 'POST /posts/:id/save': {
      await getPost(db, id);
      const exists = await db.prepare('SELECT 1 FROM saves WHERE user_id = ? AND post_id = ?').bind(me.id, id).first();
      await db.prepare(exists ? 'DELETE FROM saves WHERE user_id = ? AND post_id = ?' : 'INSERT INTO saves (user_id, post_id) VALUES (?, ?)')
        .bind(me.id, id).run();
      return json({ ok: true });
    }

    case 'POST /posts/:id/questions': {
      await getPost(db, id);
      const text = str(body.text, 1000, '質問');
      await db.prepare('INSERT INTO questions (id, post_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)').bind(newId(), id, me.id, text, Date.now()).run();
      return json({ ok: true });
    }

    case 'POST /questions/:id/answer': {
      const q = await db.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first();
      if (!q) fail(404, '質問が見つかりません');
      const post = await getPost(db, q.post_id);
      if (!canEdit(me, post)) fail(403, '回答できるのは投稿した本人と経営サイドだけです');
      const text = str(body.text, 1000, '回答');
      await db.prepare('UPDATE questions SET answer_text = ?, answered_at = ? WHERE id = ?').bind(text, Date.now(), id).run();
      return json({ ok: true });
    }

    case 'POST /categories': {
      if (me.role !== 'admin') fail(403, 'カテゴリを追加できるのは経営サイドだけです');
      const name = str(body.name, 30, 'カテゴリ名');
      if (await db.prepare('SELECT id FROM categories WHERE name = ?').bind(name).first()) fail(400, '同じ名前のカテゴリがあります');
      const cid = newId();
      await db.prepare('INSERT INTO categories (id, name, created_at) VALUES (?, ?, ?)').bind(cid, name, Date.now()).run();
      return json({ ok: true, id: cid });
    }
  }

  /* 経営サイド専用：アカウントと店舗の管理 */
  if (parts[0] === 'admin') {
    if (me.role !== 'admin') fail(403, '経営サイドだけが使えます');

    if (route === 'GET /admin/users') {
      const rows = await db.prepare('SELECT id, login_id, name, role, store_id, active, must_change, created_at FROM users ORDER BY created_at').all();
      return json({ users: rows.results.map(u => ({ id: u.id, loginId: u.login_id, name: u.name, role: u.role, storeId: u.store_id, active: !!u.active, mustChange: !!u.must_change })) });
    }

    const readUser = async () => {
      const role = ROLES.includes(body.role) ? body.role : fail(400, '役割を選んでください');
      let storeId = null;
      if (role !== 'admin') {
        storeId = str(body.storeId, 64, '店舗');
        if (!(await db.prepare('SELECT id FROM stores WHERE id = ?').bind(storeId).first())) fail(400, '店舗が見つかりません');
      }
      return { name: str(body.name, 40, '名前'), role, storeId };
    };

    if (route === 'POST /admin/users') {
      const loginId = checkLoginId(body.loginId);
      if (await db.prepare('SELECT id FROM users WHERE login_id = ?').bind(loginId).first()) fail(400, 'そのIDはすでに使われています');
      const u = await readUser();
      const { hash, salt } = await hashPassword(checkPassword(body.password));
      await db.prepare('INSERT INTO users (id, login_id, name, role, store_id, pw_hash, pw_salt, must_change, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)')
        .bind(newId(), loginId, u.name, u.role, u.storeId, hash, salt, Date.now()).run();
      return json({ ok: true });
    }

    if (route === 'PUT /admin/users/:id') {
      const target = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
      if (!target) fail(404, 'アカウントが見つかりません');
      const u = await readUser();
      const active = body.active === false ? 0 : 1;
      if (target.id === me.id && (u.role !== 'admin' || !active)) fail(400, '自分自身の経営サイド権限は外せません');
      const stmts = [db.prepare('UPDATE users SET name = ?, role = ?, store_id = ?, active = ? WHERE id = ?').bind(u.name, u.role, u.storeId, active, id)];
      if (body.password) {
        const { hash, salt } = await hashPassword(checkPassword(body.password));
        stmts.push(db.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, must_change = 1, failed = 0, locked_until = 0 WHERE id = ?').bind(hash, salt, id));
      }
      if (!active || body.password) stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
      await db.batch(stmts);
      return json({ ok: true });
    }

    if (route === 'POST /admin/stores') {
      const name = str(body.name, 30, '店舗名');
      const { n } = await db.prepare('SELECT COUNT(*) AS n FROM stores').first();
      await db.prepare('INSERT INTO stores (id, name, sort) VALUES (?, ?, ?)').bind(newId(), name, n).run();
      return json({ ok: true });
    }

    if (route === 'PUT /admin/stores/:id') {
      const name = str(body.name, 30, '店舗名');
      const r = await db.prepare('UPDATE stores SET name = ? WHERE id = ?').bind(name, id).run();
      if (!r.meta.changes) fail(404, '店舗が見つかりません');
      return json({ ok: true });
    }
  }

  fail(404, '見つかりません');
}

export async function onRequest({ request, env }) {
  try {
    return await handle(request, env);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'サーバーでエラーが起きました。時間をおいてもう一度お試しください' }, 500);
  }
}
