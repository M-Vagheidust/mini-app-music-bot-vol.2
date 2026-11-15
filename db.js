const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, 'gapmusic.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');

// Prepared Statements for high performance
const stmtGetSongById = db.prepare('SELECT * FROM songs WHERE id = ?');
const stmtGetSongByUid = db.prepare('SELECT * FROM songs WHERE uid = ? OR id = ?');
const stmtIncrementPlays = db.prepare('UPDATE songs SET plays = plays + 1 WHERE id = ?');
const stmtIncrementLikes = db.prepare('UPDATE songs SET likes = likes + 1 WHERE id = ?');
const stmtDecrementLikes = db.prepare('UPDATE songs SET likes = MAX(0, likes - 1) WHERE id = ?');
const stmtDeleteSong = db.prepare('DELETE FROM songs WHERE id = ?');
const stmtCountSongs = db.prepare('SELECT COUNT(*) as count FROM songs WHERE available = 1');
const stmtCountUsers = db.prepare('SELECT COUNT(*) as count FROM users');
const stmtCountRequests = db.prepare('SELECT COUNT(*) as count FROM requests');
const stmtCountPendingRequests = db.prepare("SELECT COUNT(*) as count FROM requests WHERE status = 'pending'");

const stmtGetFav = db.prepare('SELECT song_id FROM favorites WHERE user_id = ? AND song_id = ?');
const stmtAddFav = db.prepare('INSERT OR IGNORE INTO favorites (user_id, song_id, created_at) VALUES (?, ?, ?)');
const stmtRemoveFav = db.prepare('DELETE FROM favorites WHERE user_id = ? AND song_id = ?');
const stmtGetUserFavIds = db.prepare('SELECT song_id FROM favorites WHERE user_id = ? ORDER BY created_at DESC');

const stmtGetUser = db.prepare('SELECT * FROM users WHERE id = ?');
const stmtUpsertUser = db.prepare('INSERT INTO users (id, name, username, joined_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, username = excluded.username');

const stmtGetLyrics = db.prepare('SELECT synced_lyrics, plain_lyrics FROM lyrics_cache WHERE song_key = ?');
const stmtSaveLyrics = db.prepare('INSERT OR REPLACE INTO lyrics_cache (song_key, synced_lyrics, plain_lyrics, cached_at) VALUES (?, ?, ?, ?)');

// Bilingual aliases dictionary
const BILINGUAL_ALIASES = [
  ['tataloo', 'تتلو', 'امیر تتلو'],
  ['yas', 'یاس'],
  ['shayea', 'شایع'],
  ['pishro', 'پیشرو', 'رضا پیشرو'],
  ['hichkas', 'هیچکس'],
  ['ho3ein', 'حصین', 'hosein'],
  ['mehrad hidden', 'مهراد هیدن', 'هیدن', 'hidden'],
  ['zedbazi', 'زدبازی'],
  ['sohrab mj', 'سهراب ام جی', 'ام جی'],
  ['alireza jj', 'علیرضا جی جی', 'جی جی'],
  ['sijal', 'سیجل'],
  ['behzad leito', 'بهزاد لیتو', 'لیتو', 'leito'],
  ['khalse', 'سپهر خلسه', 'خلسه'],
  ['putak', 'پوتک', 'پوریا پوتک'],
  ['chvrsi', 'چرسی', 'charsi'],
  ['hiphopologist', 'هیپهاپولوژیست'],
  ['vinak', 'ویناک'],
  ['021kid', '۰۲۱کید', '021'],
  ['dorcci', 'دورچی', 'dorci'],
  ['koorosh', 'کوروش'],
  ['artin', 'ارتین'],
  ['erfan', 'عرفان', 'پایدار'],
  ['isogand', 'سوگند', 'sogand'],
  ['shadmehr', 'شادمهر', 'شادمهر عقیلی'],
  ['ebi', 'ابی'],
  ['dariush', 'داریوش'],
  ['siavash ghomayshi', 'سیاوش قمیشی', 'قمیشی'],
  ['moein', 'معین'],
  ['haydeh', 'هایده', 'hayedeh'],
  ['mahasti', 'مهستی'],
  ['googoosh', 'گوگوش'],
  ['chavoshi', 'محسن چاوشی', 'چاوشی'],
  ['yegane', 'محسن یگانه', 'یگانه'],
  ['sirvan', 'سیروان', 'سیروان خسروی'],
  ['xaniar', 'زانیار', 'زانیار خسروی'],
  ['macan', 'ماکان', 'ماکان بند'],
  ['ashvan', 'اشوان'],
  ['aron afshar', 'آرون افشار'],
  ['garsha rezaei', 'گرشا رضایی'],
  ['reza bahram', 'رضا بهرام'],
  ['ali yasini', 'علی یاسینی'],
  ['haamim', 'حامیم', 'hamim'],
  ['the weeknd', 'weeknd', 'ویکند', 'د ویکند'],
  ['drake', 'دریک'],
  ['eminem', 'امینم'],
  ['travis scott', 'تراویس اسکات', 'تراویس'],
  ['kendrick lamar', 'کندریک لامار', 'کندریک'],
  ['kanye west', 'کانیه وست', 'کانیه'],
  ['post malone', 'پست مالون'],
  ['billie eilish', 'بیلی آیلیش'],
  ['lana del rey', 'لانا دل ری'],
  ['taylor swift', 'تیلور سوئیفت'],
  ['adele', 'ادل'],
  ['rihanna', 'ریحانا'],
  ['beyonce', 'بیانسه'],
  ['justin bieber', 'جاستین بیبر'],
  ['selena gomez', 'سلنا گومز'],
  ['dua lipa', 'دوا لیپا'],
  ['shakira', 'شکیرا'],
  ['ed sheeran', 'اد شیرن'],
  ['coldplay', 'کلدپلی'],
  ['imagine dragons', 'ایمجین دراگونز'],
  ['xxxtenacion', 'xxxtentacion', 'تنتاسیون', 'ایکس'],
  ['juice wrld', 'جویس ورلد'],
  ['2pac', 'tupac', 'توپاک'],
  ['snoop dogg', 'اسنوپ داگ'],
  ['50 cent', 'فیفتی سنت'],
  ['central cee', 'سنترال سی'],
  ['metro boomin', 'مترو بومین'],
  ['future', 'فیوچر'],
  ['21 savage', '۲۱ سویج', 'تونی وان سویج'],
  ['playboi carti', 'پلی بوی کارتی'],
  ['lil wayne', 'لیل وین'],
  ['tame impala', 'تیم ایمپالا'],
  ['arctic monkeys', 'آرکتیک مانکیز'],
  ['daft punk', 'دفت پانک'],
  ['alan walker', 'آلن واکر'],
  ['marshmello', 'مارشملو'],
  ['remix', 'ریمیکس'],
  ['slowed', 'اسلود'],
  ['reverb', 'ریورب']
];

function normalizeText(text) {
  if (!text) return '';
  let t = String(text).toLowerCase();
  const map = {
    'ي': 'ی', 'ك': 'ک', 'آ': 'ا', 'أ': 'ا', 'إ': 'ا',
    'ۀ': 'ه', 'ة': 'ه', 'ؤ': 'و', 'ئ': 'ی',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
    '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
    '\u200c': ' ', '_': ' ', '-': ' ', '.': ' ', '/': ' ', '\\': ' '
  };
  for (const [k, v] of Object.entries(map)) {
    t = t.split(k).join(v);
  }
  return t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function persianToLatinPhonetic(text) {
  const norm = normalizeText(text);
  if (!/[آ-ی]/.test(norm)) return norm;
  const charMap = {
    'ا': 'a', 'ب': 'b', 'پ': 'p', 'ت': 't', 'ط': 't', 'ث': 's', 'س': 's', 'ص': 's',
    'ج': 'j', 'چ': 'ch', 'ح': 'h', 'ه': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'z', 'ز': 'z',
    'ض': 'z', 'ظ': 'z', 'ر': 'r', 'ژ': 'zh', 'ش': 'sh', 'ع': 'a', 'غ': 'gh', 'ق': 'gh',
    'ف': 'f', 'ک': 'k', 'گ': 'g', 'ل': 'l', 'م': 'm', 'ن': 'n', 'و': 'o', 'ی': 'i'
  };
  let out = '';
  for (const ch of norm) {
    out += charMap[ch] !== undefined ? charMap[ch] : ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function expandBilingualTerms(text) {
  const norm = normalizeText(text);
  if (!norm) return '';
  const extras = new Set([norm]);
  const phonetic = persianToLatinPhonetic(norm);
  if (phonetic && phonetic !== norm) extras.add(phonetic);

  for (const group of BILINGUAL_ALIASES) {
    const normGroup = group.map(g => normalizeText(g));
    if (normGroup.some(alias => alias && (norm.includes(alias) || (alias.includes(norm) && norm.length >= 3)))) {
      normGroup.forEach(a => extras.add(a));
    }
  }
  return Array.from(extras).join(' ');
}

// Format query into FTS5 safe string
function formatFtsQuery(rawQuery) {
  const expanded = expandBilingualTerms(rawQuery);
  const tokens = Array.from(new Set(expanded.split(/\s+/).map(t => t.replace(/[^\p{L}\p{N}]/gu, '')).filter(t => t.length >= 2)));
  if (!tokens.length) return '';
  // OR between tokens to find any relevance, with prefix matching
  return tokens.map(t => `"${t}"*`).join(' OR ');
}

const DB = {
  getSongById(id) {
    return stmtGetSongById.get(Number(id)) || null;
  },

  getSongByUid(uid) {
    const num = parseInt(uid, 10);
    return stmtGetSongByUid.get(String(uid), isNaN(num) ? -1 : num) || null;
  },

  incrementPlays(songId) {
    stmtIncrementPlays.run(Number(songId));
  },

  deleteSong(songId) {
    const song = this.getSongById(songId);
    if (!song) return null;
    stmtDeleteSong.run(Number(songId));
    return song;
  },

  getSongs({ query = '', filter = 'all', offset = 0, limit = 60 } = {}) {
    offset = Math.max(0, parseInt(offset, 10) || 0);
    limit = Math.min(200, Math.max(1, parseInt(limit, 10) || 60));

    if (query && query.trim()) {
      return this.searchSongs(query.trim(), { filter, offset, limit });
    }

    let orderClause = 'ORDER BY id DESC';
    if (filter === 'popular') {
      orderClause = 'ORDER BY plays DESC, likes DESC';
    }

    const items = db.prepare(`SELECT * FROM songs WHERE available = 1 ${orderClause} LIMIT ? OFFSET ?`).all(limit, offset);
    const totalRow = stmtCountSongs.get();
    const total = totalRow ? totalRow.count : 0;

    return { total, offset, limit, has_more: offset + items.length < total, items };
  },

  searchSongs(rawQuery, { filter = 'all', offset = 0, limit = 60 } = {}) {
    offset = Math.max(0, parseInt(offset, 10) || 0);
    limit = Math.min(200, Math.max(1, parseInt(limit, 10) || 60));

    const ftsQuery = formatFtsQuery(rawQuery);
    let items = [];
    let total = 0;

    if (ftsQuery) {
      try {
        let orderClause = 'ORDER BY bm25(songs_fts) ASC, s.plays DESC';
        if (filter === 'popular') {
          orderClause = 'ORDER BY s.plays DESC, s.likes DESC';
        }

        const countQuery = `
          SELECT COUNT(*) as count
          FROM songs s
          JOIN songs_fts f ON s.id = f.id
          WHERE f.songs_fts MATCH ? AND s.available = 1
        `;
        const countRow = db.prepare(countQuery).get(ftsQuery);
        total = countRow ? countRow.count : 0;

        const selectQuery = `
          SELECT s.*
          FROM songs s
          JOIN songs_fts f ON s.id = f.id
          WHERE f.songs_fts MATCH ? AND s.available = 1
          ${orderClause}
          LIMIT ? OFFSET ?
        `;
        items = db.prepare(selectQuery).all(ftsQuery, limit, offset);
      } catch (e) {
        // Fallback to LIKE if FTS syntax error occurs
        items = [];
        total = 0;
      }
    }

    // Fallback if FTS returned 0 results
    if (items.length === 0 && total === 0) {
      const norm = normalizeText(rawQuery);
      if (norm) {
        const likePattern = `%${norm}%`;
        const countRow = db.prepare('SELECT COUNT(*) as count FROM songs WHERE available = 1 AND search_text LIKE ?').get(likePattern);
        total = countRow ? countRow.count : 0;
        items = db.prepare('SELECT * FROM songs WHERE available = 1 AND search_text LIKE ? ORDER BY plays DESC LIMIT ? OFFSET ?').all(likePattern, limit, offset);
      }
    }

    return { total, offset, limit, has_more: offset + items.length < total, items };
  },

  getRandomSong() {
    return db.prepare('SELECT * FROM songs WHERE available = 1 ORDER BY RANDOM() LIMIT 1').get() || null;
  },

  registerUser(user) {
    if (!user || !user.id) return;
    const uid = String(user.id);
    const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.name || '';
    stmtUpsertUser.run(uid, fullName, user.username || '', Math.floor(Date.now() / 1000));
  },

  getUser(userId) {
    return stmtGetUser.get(String(userId)) || null;
  },

  toggleFavorite(userId, songId) {
    const uid = String(userId);
    const sid = Number(songId);
    const exists = stmtGetFav.get(uid, sid);
    let liked = false;

    if (exists) {
      stmtRemoveFav.run(uid, sid);
      stmtDecrementLikes.run(sid);
      liked = false;
    } else {
      stmtAddFav.run(uid, sid, Math.floor(Date.now() / 1000));
      stmtIncrementLikes.run(sid);
      liked = true;
    }

    const updatedSong = this.getSongById(sid);
    const favRows = stmtGetUserFavIds.all(uid);
    const favorites = favRows.map(r => r.song_id);

    return { liked, likes: updatedSong ? updatedSong.likes : 0, favorites };
  },

  getUserFavorites(userId) {
    const uid = String(userId);
    const favRows = stmtGetUserFavIds.all(uid);
    const favorite_ids = favRows.map(r => r.song_id);
    if (!favorite_ids.length) return { favorite_ids: [], items: [] };

    // Fetch songs in same order
    const placeholders = favorite_ids.map(() => '?').join(',');
    const songs = db.prepare(`SELECT * FROM songs WHERE id IN (${placeholders}) AND available = 1`).all(...favorite_ids);
    const map = new Map(songs.map(s => [s.id, s]));
    const items = favorite_ids.map(id => map.get(id)).filter(Boolean);

    return { favorite_ids, items };
  },

  getStats() {
    const totalSongs = stmtCountSongs.get()?.count || 0;
    const totalUsers = stmtCountUsers.get()?.count || 0;
    const totalRequests = stmtCountRequests.get()?.count || 0;
    const pendingRequests = stmtCountPendingRequests.get()?.count || 0;
    return {
      total_songs: totalSongs,
      total_users: totalUsers,
      total_requests: totalRequests,
      pending_requests: pendingRequests
    };
  },

  addSong(songData) {
    const id = songData.id || (db.prepare('SELECT MAX(id) as max_id FROM songs').get()?.max_id || 0) + 1;
    const uid = songData.uid || `${id}_${songData.message_id || Date.now()}`;
    const search_text = songData.search_text || expandBilingualTerms(`${songData.title} ${songData.performer}`);

    db.prepare(`
      INSERT OR REPLACE INTO songs (
        id, uid, from_chat_id, message_id, file_id, file_unique_id,
        title, performer, search_text, media_type, plays, likes, available
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, uid,
      songData.from_chat_id ? String(songData.from_chat_id) : null,
      songData.message_id ? parseInt(songData.message_id, 10) : null,
      songData.file_id || '',
      songData.file_unique_id || '',
      songData.title || 'نامشخص',
      songData.performer || 'نامشخص',
      search_text,
      songData.media_type || 'audio',
      songData.plays || 0,
      songData.likes || 0,
      songData.available !== undefined ? (songData.available ? 1 : 0) : 1
    );

    return this.getSongById(id);
  },

  updateSongFile(id, { file_id, file_unique_id, from_chat_id, message_id }) {
    db.prepare(`
      UPDATE songs SET
        file_id = COALESCE(?, file_id),
        file_unique_id = COALESCE(?, file_unique_id),
        from_chat_id = COALESCE(?, from_chat_id),
        message_id = COALESCE(?, message_id),
        available = 1
      WHERE id = ?
    `).run(file_id, file_unique_id, from_chat_id ? String(from_chat_id) : null, message_id, Number(id));
  },

  findSongByUniqueIdOrSearch(fileUniqueId, normSearch) {
    if (fileUniqueId) {
      const byUnique = db.prepare('SELECT * FROM songs WHERE file_unique_id = ?').get(fileUniqueId);
      if (byUnique) return byUnique;
    }
    if (normSearch && normSearch.length > 5) {
      const bySearch = db.prepare('SELECT * FROM songs WHERE search_text = ? LIMIT 1').get(normSearch);
      if (bySearch) return bySearch;
    }
    return null;
  },

  addSongRequest(userId, userName, queryText) {
    const cleanQ = String(queryText || '').trim();
    if (!cleanQ) return null;
    const uid = String(userId);

    const existing = db.prepare("SELECT * FROM requests WHERE user_id = ? AND status = 'pending' AND query = ?").get(uid, cleanQ);
    if (existing) return existing;

    const expanded = expandBilingualTerms(cleanQ);
    const res = db.prepare(`
      INSERT INTO requests (user_id, user_name, query, expanded_query, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(uid, userName || 'کاربر', cleanQ, expanded, Math.floor(Date.now() / 1000));

    return {
      id: res.lastInsertRowid,
      user_id: uid,
      user_name: userName || 'کاربر',
      query: cleanQ,
      status: 'pending'
    };
  },

  getPendingRequests() {
    return db.prepare("SELECT * FROM requests WHERE status = 'pending'").all();
  },

  fulfillRequest(reqId, songId) {
    db.prepare("UPDATE requests SET status = 'fulfilled', fulfilled_song_id = ?, fulfilled_at = ? WHERE id = ?").run(
      Number(songId),
      Math.floor(Date.now() / 1000),
      Number(reqId)
    );
  },

  getCachedLyrics(songKey) {
    const row = stmtGetLyrics.get(String(songKey).toLowerCase());
    if (!row) return null;
    return {
      syncedLyrics: row.synced_lyrics,
      plainLyrics: row.plain_lyrics
    };
  },

  saveCachedLyrics(songKey, syncedLyrics, plainLyrics) {
    stmtSaveLyrics.run(
      String(songKey).toLowerCase(),
      syncedLyrics || '',
      plainLyrics || '',
      Math.floor(Date.now() / 1000)
    );
  },

  expandBilingualTerms,
  normalizeText
};

module.exports = DB;
