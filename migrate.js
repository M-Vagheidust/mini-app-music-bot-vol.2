const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, 'gapmusic.db');
const JSON_FILE = path.join(__dirname, 'songs_db.json');
const USERS_FILE = path.join(__dirname, 'users_db.json');

console.log('🚀 شروع فرآیند مایگریشن به SQLite...');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');

// Create tables
db.exec(`
CREATE TABLE IF NOT EXISTS songs (
  id INTEGER PRIMARY KEY,
  uid TEXT UNIQUE,
  from_chat_id TEXT,
  message_id INTEGER,
  file_id TEXT,
  file_unique_id TEXT,
  title TEXT,
  performer TEXT,
  search_text TEXT,
  media_type TEXT DEFAULT 'audio',
  plays INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  available INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_songs_plays ON songs (plays DESC);
CREATE INDEX IF NOT EXISTS idx_songs_likes ON songs (likes DESC);
CREATE INDEX IF NOT EXISTS idx_songs_id_desc ON songs (id DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS songs_fts USING fts5(
  id UNINDEXED,
  title,
  performer,
  search_text
);

DROP TRIGGER IF EXISTS songs_ai;
DROP TRIGGER IF EXISTS songs_ad;
DROP TRIGGER IF EXISTS songs_au;

CREATE TRIGGER songs_ai AFTER INSERT ON songs BEGIN
  INSERT INTO songs_fts(id, title, performer, search_text)
  VALUES (new.id, new.title, new.performer, new.search_text);
END;

CREATE TRIGGER songs_ad AFTER DELETE ON songs BEGIN
  DELETE FROM songs_fts WHERE id = old.id;
END;

CREATE TRIGGER songs_au AFTER UPDATE ON songs BEGIN
  DELETE FROM songs_fts WHERE id = old.id;
  INSERT INTO songs_fts(id, title, performer, search_text)
  VALUES (new.id, new.title, new.performer, new.search_text);
END;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT,
  username TEXT,
  joined_at INTEGER
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id TEXT,
  song_id INTEGER,
  created_at INTEGER,
  PRIMARY KEY (user_id, song_id)
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  user_name TEXT,
  query TEXT,
  expanded_query TEXT,
  status TEXT DEFAULT 'pending',
  fulfilled_song_id INTEGER,
  created_at INTEGER,
  fulfilled_at INTEGER
);

CREATE TABLE IF NOT EXISTS lyrics_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_key TEXT UNIQUE,
  synced_lyrics TEXT,
  plain_lyrics TEXT,
  cached_at INTEGER
);
`);

// Check if songs table already has data
const countResult = db.prepare('SELECT COUNT(*) as count FROM songs').get();
if (countResult && countResult.count > 0) {
  console.log(`ℹ️ جدول songs قبلاً دارای ${countResult.count} رکورد بوده است.`);
} else if (fs.existsSync(JSON_FILE)) {
  console.log('📂 در حال خواندن songs_db.json...');
  const raw = fs.readFileSync(JSON_FILE, 'utf8').replace(/^\uFEFF/, '');
  const items = JSON.parse(raw);
  const songsList = Array.isArray(items) ? items : (items.songs || []);

  console.log(`📊 تعداد کل آهنگ‌ها برای انتقال: ${songsList.length}`);

  const insertSong = db.prepare(`
    INSERT OR REPLACE INTO songs (
      id, uid, from_chat_id, message_id, file_id, file_unique_id,
      title, performer, search_text, media_type, plays, likes, available
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN TRANSACTION;');
  let inserted = 0;
  for (const s of songsList) {
    const id = parseInt(s.id, 10) || (inserted + 1);
    const uid = String(s.uid || `${id}_${s.message_id || inserted}`);
    const from_chat_id = s.from_chat_id ? String(s.from_chat_id) : null;
    const message_id = s.message_id ? parseInt(s.message_id, 10) : null;
    const file_id = s.file_id ? String(s.file_id) : '';
    const file_unique_id = s.file_unique_id ? String(s.file_unique_id) : '';
    const title = String(s.title || 'نامشخص');
    const performer = String(s.performer || 'نامشخص');
    const search_text = String(s.search_text || `${title} ${performer}`).toLowerCase();
    const media_type = String(s.media_type || 'audio');
    const plays = parseInt(s.plays, 10) || 0;
    const likes = parseInt(s.likes, 10) || 0;
    const available = s.available !== undefined ? (s.available ? 1 : 0) : 1;

    insertSong.run(
      id, uid, from_chat_id, message_id, file_id, file_unique_id,
      title, performer, search_text, media_type, plays, likes, available
    );
    inserted++;
  }
  db.exec('COMMIT;');
  console.log(`✅ ${inserted} آهنگ با موفقیت در تراکنش SQLite ذخیره و در FTS5 ایندکس شد!`);
}

// Migrate users if users_db.json exists
if (fs.existsSync(USERS_FILE)) {
  try {
    const uData = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    const users = uData.users || {};
    const requests = uData.requests || [];

    const insertUser = db.prepare('INSERT OR REPLACE INTO users (id, name, username, joined_at) VALUES (?, ?, ?, ?)');
    const insertFav = db.prepare('INSERT OR IGNORE INTO favorites (user_id, song_id, created_at) VALUES (?, ?, ?)');
    const insertReq = db.prepare('INSERT OR REPLACE INTO requests (id, user_id, user_name, query, expanded_query, status, fulfilled_song_id, created_at, fulfilled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

    db.exec('BEGIN TRANSACTION;');
    for (const [uid, u] of Object.entries(users)) {
      insertUser.run(String(uid), u.name || '', u.username || '', u.joined_at || Math.floor(Date.now() / 1000));
      if (Array.isArray(u.favorites)) {
        for (const songId of u.favorites) {
          insertFav.run(String(uid), parseInt(songId, 10), Math.floor(Date.now() / 1000));
        }
      }
    }

    for (const r of requests) {
      insertReq.run(
        r.id || null,
        String(r.user_id || ''),
        r.user_name || '',
        r.query || '',
        r.expanded_query || '',
        r.status || 'pending',
        r.fulfilled_song_id || null,
        r.created_at || Math.floor(Date.now() / 1000),
        r.fulfilled_at || null
      );
    }
    db.exec('COMMIT;');
    console.log('✅ کاربران و درخواست‌ها نیز منتقل شدند.');
  } catch (e) {
    console.error('خطا در انتقال کاربران:', e.message);
  }
}

console.log('🎉 مایگریشن به پایان رسید!');
