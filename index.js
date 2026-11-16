require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const DB = require('./db.js');

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const STORAGE_BOT_TOKEN = (process.env.STORAGE_BOT_TOKEN || '').trim();
let rawUrl = (process.env.MINI_APP_URL || '').replace(/\/$/, '').trim();
const MINI_APP_URL = rawUrl ? (rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`) : '';
const APP_VERSION = '2.3.0';
const WEB_APP_URL = MINI_APP_URL
  ? (MINI_APP_URL.includes('?') ? `${MINI_APP_URL}&v=${APP_VERSION}` : `${MINI_APP_URL}?v=${APP_VERSION}`)
  : '';
const PORT = parseInt(process.env.PORT || '8080', 10);
const ADMIN_IDS = (process.env.ADMIN_IDS || '849152312')
  .split(',')
  .map(s => parseInt(s.trim(), 10))
  .filter(Boolean);
const GROUP_URL = (process.env.GROUP_URL || '').trim();

if (!BOT_TOKEN) {
  console.error('❌ خطا: متغیر محیطی BOT_TOKEN در Railway تنظیم نشده است!');
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const WEBHOOK_SECRET = crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 32);
const WEBHOOK_PATH = `/telegraf/${WEBHOOK_SECRET}`;

let BOT_USERNAME = '';
const COVER_CACHE = new Map();

function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

function cleanDisplayText(text) {
  if (!text) return 'نامشخص';
  let t = String(text)
    .replace(/\.(mp3|m4a|ogg|flac|wav)+$/i, '')
    .replace(/^\s*\d+\s*[\|\s\-\.]+\d*\s*[\-\._]+\s*/, '')
    .replace(/\(\s*(320|128|160)\s*\)/g, '')
    .replace(/(@\w+|\[.*?\]|~.*)/g, '')
    .replace(/_/g, ' ')
    .replace(/^[\s\-_|/؛.]+|[\s\-_|/؛.]+$/g, '');
  return t || 'نامشخص';
}

function resolveUserId(initData, fallbackId) {
  if (initData && BOT_TOKEN) {
    try {
      const params = new URLSearchParams(initData);
      const hash = params.get('hash');
      if (hash) {
        params.delete('hash');
        const keys = Array.from(params.keys()).sort();
        const dataCheckString = keys.map(k => `${k}=${params.get(k)}`).join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (calcHash === hash && params.has('user')) {
          const u = JSON.parse(params.get('user'));
          if (u?.id) return u.id;
        }
      }
      if (params.has('user')) {
        const u = JSON.parse(params.get('user'));
        if (u?.id) return u.id;
      }
    } catch (e) {}
  }
  if (fallbackId && String(fallbackId).trim() !== '' && String(fallbackId) !== 'undefined') {
    return fallbackId;
  }
  return null;
}

async function resolvePlayableFile(song, fallbackChatId = null) {
  let lastError = 'اطلاعات فایل ناقص است';

  if (song.file_id && String(song.file_id).trim()) {
    try {
      const check = await axios.get(`${TELEGRAM_API}/getFile`, {
        params: { file_id: song.file_id },
        timeout: 10000
      });
      if (check.data?.ok && check.data?.result?.file_path) {
        return { fileId: song.file_id, filePath: check.data.result.file_path, fileApi: TELEGRAM_FILE_API };
      }
    } catch (e) {
      lastError = e.response?.data?.description || e.message;
    }
  }

  if (STORAGE_BOT_TOKEN && STORAGE_BOT_TOKEN !== BOT_TOKEN && song.file_id && String(song.file_id).trim()) {
    try {
      const checkStorage = await axios.get(`https://api.telegram.org/bot${STORAGE_BOT_TOKEN}/getFile`, {
        params: { file_id: song.file_id },
        timeout: 10000
      });
      if (checkStorage.data?.ok && checkStorage.data?.result?.file_path) {
        return {
          filePath: checkStorage.data.result.file_path,
          fileApi: `https://api.telegram.org/file/bot${STORAGE_BOT_TOKEN}`
        };
      }
    } catch (eStorage) {}
  }

  const forwardDests = [fallbackChatId, ...ADMIN_IDS].filter(Boolean);
  if (song.from_chat_id && song.message_id && forwardDests.length > 0) {
    let chatId = String(song.from_chat_id).trim();
    const candidates = [chatId];
    if (!chatId.startsWith('-100') && chatId.startsWith('-')) {
      candidates.push(`-100${chatId.slice(1)}`);
    } else if (!chatId.startsWith('-') && chatId.length >= 9) {
      candidates.push(`-100${chatId}`);
    }

    for (const destChat of forwardDests) {
      for (const targetChat of candidates) {
        try {
          const fwd = await axios.post(`${TELEGRAM_API}/forwardMessage`, {
            chat_id: destChat,
            from_chat_id: targetChat,
            message_id: song.message_id,
            disable_notification: true
          }, { timeout: 12000 });

          const msg = fwd.data?.result;
          const audioObj = msg?.audio || msg?.document || msg?.voice;

          if (audioObj?.file_id) {
            DB.updateSongFile(song.id, { file_id: audioObj.file_id, from_chat_id: targetChat });

            if (ADMIN_IDS.includes(Number(destChat)) && destChat !== fallbackChatId && msg?.message_id) {
              axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id: destChat, message_id: msg.message_id }).catch(() => {});
            }

            const check2 = await axios.get(`${TELEGRAM_API}/getFile`, {
              params: { file_id: audioObj.file_id },
              timeout: 10000
            });
            if (check2.data?.ok && check2.data?.result?.file_path) {
              return {
                fileId: audioObj.file_id,
                filePath: check2.data.result.file_path,
                alreadyDelivered: (destChat === fallbackChatId)
              };
            }
            return {
              fileId: audioObj.file_id,
              alreadyDelivered: (destChat === fallbackChatId)
            };
          }
        } catch (e) {
          lastError = `(${targetChat}): ${e.response?.data?.description || e.message}`;
        }
      }
    }
  }

  return { error: lastError };
}

async function notifyFulfilledRequests(song) {
  const pending = DB.getPendingRequests();
  if (!pending.length) return;

  const songSearch = song.search_text || DB.expandBilingualTerms(`${song.title} ${song.performer}`);

  for (const req of pending) {
    const reqExpanded = req.expanded_query || DB.expandBilingualTerms(req.query);
    const tokens = reqExpanded.split(' ').filter(t => t.length >= 2);
    if (!tokens.length) continue;

    const isMatch = tokens.some(t => songSearch.includes(t));
    if (isMatch && req.user_id) {
      DB.fulfillRequest(req.id, song.id);

      const notifyText =
        `🎉 **خبر خوش! موزیک درخواستی شما آماده شد**\n\n` +
        `🎵 خواننده: **${song.performer}**\n` +
        `🎧 نام آهنگ: **${song.title}**\n` +
        `📌 کد موزیک: #${song.id}\n\n` +
        `👇 همین الان دریافت کنید یا در مینی‌اپ بشنوید:`;

      const buttons = [
        [{ text: '📥 دریافت فایل موزیک', callback_data: `dl_${song.id}` }]
      ];
      if (WEB_APP_URL) {
        buttons.push([{ text: '🎧 پخش آنلاین در مینی‌اپ', web_app: { url: WEB_APP_URL } }]);
      }

      axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: req.user_id,
        text: notifyText,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
      }).catch(() => {});
    }
  }
}

async function sendAutoDeleteReply(ctx, text, delayMs = 5000) {
  try {
    const sent = await ctx.reply(text);
    setTimeout(() => {
      ctx.telegram.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {});
    }, delayMs);
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Telegram Bot Setup (Telegraf)
// ---------------------------------------------------------------------------
const bot = new Telegraf(BOT_TOKEN);
const userSessions = new Map();

bot.catch((err, ctx) => {
  console.error('❌ خطای داخلی Telegraf:', err);
});

function buildMainMenu(userId) {
  const stats = DB.getStats();
  const favCount = DB.getUserFavorites(userId).favorite_ids.length;

  const text =
    `سلام! 👋 به ربات و پلیر هوشمند **GapMusic** خوش آمدید.\n\n` +
    `🎼 آرشیو موزیک‌های فعال: **${stats.total_songs}** ترک 🎵\n` +
    `❤️ پلی‌لیست شخصی شما: **${favCount}** موزیک\n` +
    `📤 هر موزیکی که بفرستید به صورت خودکار به دیتابیس اضافه می‌شود!\n\n` +
    `💡 نام خواننده یا آهنگ را به فارسی یا انگلیسی تایپ کنید:`;

  const rows = [];
  if (WEB_APP_URL) {
    rows.push([Markup.button.webApp('🎧 ورود به مینی‌اپ GapMusic', WEB_APP_URL)]);
  }
  rows.push([
    Markup.button.callback('🎵 کل موزیک‌ها', 'list_all'),
    Markup.button.callback('🎲 موزیک شانسی', 'random_song')
  ]);
  rows.push([
    Markup.button.callback('🔥 پرطرفدارترین‌ها', 'top_songs'),
    Markup.button.callback('🆕 جدیدترین‌ها', 'newest_songs')
  ]);
  rows.push([
    Markup.button.callback(`❤️ پلی‌لیست من (${favCount})`, 'my_favorites'),
    Markup.button.callback('📩 درخواست موزیک', 'request_song')
  ]);
  const lastRow = [Markup.button.switchToCurrentChat('⚡ سرچ آنی (Inline)', '.')];
  if (GROUP_URL && GROUP_URL.startsWith('http')) {
    lastRow.push(Markup.button.url('🌐 کانال / گپ ما', GROUP_URL));
  }
  rows.push(lastRow);

  if (isAdmin(userId)) {
    rows.push([Markup.button.callback('🛡️ پنل مدیریت ادمین', 'admin_panel')]);
  }

  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

function buildSongListKeyboard(songs, page = 0, perPage = 6) {
  const totalPages = Math.max(1, Math.ceil(songs.length / perPage));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = songs.slice(safePage * perPage, (safePage + 1) * perPage);

  const rows = slice.map(s => {
    const icon = s.plays >= 10 ? '🔥' : '🎵';
    return [Markup.button.callback(`${icon} ${s.performer} - ${s.title}`.slice(0, 58), `dl_${s.id}`)];
  });

  const nav = [];
  if (safePage > 0) nav.push(Markup.button.callback('◀️ قبلی', `page_${safePage - 1}`));
  nav.push(Markup.button.callback(`📄 ${safePage + 1} از ${totalPages}`, 'noop'));
  if (safePage < totalPages - 1) nav.push(Markup.button.callback('بعدی ▶️', `page_${safePage + 1}`));
  rows.push(nav);

  if (WEB_APP_URL) {
    rows.push([Markup.button.webApp('🎧 پخش آنلاین در مینی‌اپ', WEB_APP_URL)]);
  }
  rows.push([Markup.button.callback('🔙 منوی اصلی', 'main_menu')]);
  return Markup.inlineKeyboard(rows);
}

async function sendSongToChat(ctx, chatId, song, userId) {
  DB.incrementPlays(song.id);

  const favs = DB.getUserFavorites(userId).favorite_ids;
  const liked = favs.includes(song.id);
  const likeBtnText = liked ? `❤️ در پلی‌لیست (${song.likes})` : `🤍 افزودن به پلی‌لیست (${song.likes})`;

  const rows = [
    [
      Markup.button.callback(likeBtnText, `like_${song.id}`),
      Markup.button.callback('🎲 آهنگ بعدی', 'random_song')
    ]
  ];
  if (isAdmin(userId)) {
    rows.push([Markup.button.callback('🗑️ حذف این آهنگ (ادمین)', `admdel_${song.id}`)]);
  }
  if (WEB_APP_URL) {
    rows.push([Markup.button.webApp('🎧 باز کردن پلیر مینی‌اپ', WEB_APP_URL)]);
  }

  const caption = `🎵 ${song.performer} - ${song.title}\n▶️ دریافت: ${song.plays + 1} مرتبه | 🆔 #${song.id}`;
  const extra = { caption, ...Markup.inlineKeyboard(rows) };

  const resolved = await resolvePlayableFile(song, chatId);

  if (resolved?.alreadyDelivered) {
    return true;
  }

  if (resolved?.fileId) {
    try {
      await ctx.telegram.sendAudio(chatId, resolved.fileId, extra);
      return true;
    } catch (e1) {
      try {
        await ctx.telegram.sendDocument(chatId, resolved.fileId, extra);
        return true;
      } catch (e2) {}
    }
  }

  if (resolved?.filePath) {
    try {
      const fileUrl = `${resolved.fileApi || TELEGRAM_FILE_API}/${resolved.filePath}`;
      const sent = await ctx.telegram.sendAudio(chatId, { url: fileUrl }, extra);
      if (sent?.audio?.file_id) {
        DB.updateSongFile(song.id, { file_id: sent.audio.file_id });
      }
      return true;
    } catch (eUrl) {
      console.error('Send via URL in bot failed:', eUrl.response?.data || eUrl.message);
    }
  }

  if (song.from_chat_id && song.message_id) {
    try {
      await ctx.telegram.copyMessage(chatId, song.from_chat_id, song.message_id, extra);
      return true;
    } catch (eCopy) {}
  }

  await ctx.reply(
    `⚠️ متأسفانه فایل این موزیک در تلگرام در دسترس نیست.\nمی‌توانید آن را از طریق دکمه «🎧 پخش آنلاین در مینی‌اپ» گوش دهید یا دانلود کنید.`
  );
  return false;
}

bot.start(async (ctx) => {
  DB.registerUser(ctx.from);

  const rawText = ctx.message?.text || '';
  const parts = rawText.trim().split(/\s+/);
  const payload = (parts.length > 1 ? parts[1] : '') || ctx.startPayload || '';

  if (payload.startsWith('song_')) {
    const songId = parseInt(payload.replace('song_', ''), 10);
    const song = DB.getSongById(songId);

    if (!song) {
      await ctx.reply('❌ متأسفانه این موزیک در آرشیو پیدا نشد.');
      return;
    }

    const waitMsg = await ctx.reply(`⏳ در حال آماده‌سازی و ارسال «${song.title}»...`);
    const ok = await sendSongToChat(ctx, ctx.chat.id, song, ctx.from.id);
    await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});

    if (ok) return;

    await ctx.reply('⚠️ دسترسی به فایل این موزیک برقرار نشد.');
    return;
  }

  const { text, keyboard } = buildMainMenu(ctx.from.id);
  await ctx.replyWithMarkdown(text, keyboard);
});

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const stats = DB.getStats();
  const msg =
    `🛡️ **پنل مدیریت ادمین GapMusic (نسخه دیتابیس SQLite)**\n\n` +
    `🎵 کل موزیک‌های فعال: **${stats.total_songs}**\n` +
    `👥 تعداد کاربران: **${stats.total_users}**\n` +
    `📩 درخواست‌های در انتظار: **${stats.pending_requests}** (کل: ${stats.total_requests})\n\n` +
    `📌 **روش‌های حذف آهنگ:**\n` +
    `1️⃣ داخل مینی‌اپ، روی دکمه 🗑️ کنار هر آهنگ بزنید.\n` +
    `2️⃣ دستور \`/del کد_آهنگ\` را بفرستید (مثلاً: \`/del 125\`).`;

  await ctx.replyWithMarkdown(msg, Markup.inlineKeyboard([
    WEB_APP_URL ? [Markup.button.webApp('🛡️ ورود به پنل مدیریتی در مینی‌اپ', WEB_APP_URL)] : [],
    [Markup.button.callback('📦 دریافت فایل دیتابیس', 'admin_export')]
  ].filter(r => r.length > 0)));
});

bot.command('del', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  const songId = parseInt(parts[1], 10);
  if (!songId) return ctx.reply('⚠️ فرمت صحیح: `/del 120`', { parse_mode: 'Markdown' });

  const removed = DB.deleteSong(songId);
  if (!removed) return ctx.reply('❌ آهنگی با این کد پیدا نشد.');
  await ctx.reply(`🗑️ موزیک «${removed.performer} - ${removed.title}» (کد #${songId}) با موفقیت حذف شد.`);
});

bot.action('admin_panel', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('دسترسی غیرمجاز', { show_alert: true });
  const stats = DB.getStats();
  const msg =
    `🛡️ **پنل مدیریت ادمین GapMusic (نسخه SQLite)**\n\n` +
    `🎵 کل موزیک‌های فعال: **${stats.total_songs}**\n` +
    `👥 تعداد کاربران: **${stats.total_users}**\n` +
    `📩 درخواست‌های در انتظار: **${stats.pending_requests}**\n\n` +
    `💡 برای حذف سریع: دستور \`/del کد_آهنگ\` را بفرستید یا در مینی‌اپ آیکون 🗑️ را بزنید.`;

  const rows = [];
  if (WEB_APP_URL) {
    rows.push([Markup.button.webApp('🛡️ مدیریت و حذف در مینی‌اپ', WEB_APP_URL)]);
  }
  rows.push([Markup.button.callback('📦 دریافت فایل دیتابیس', 'admin_export')]);
  rows.push([Markup.button.callback('🔙 منوی اصلی', 'main_menu')]);

  await ctx.editMessageText(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(rows)
  }).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('admin_export', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery('📦 در حال ارسال فایل...');
  const dbFile = path.join(__dirname, 'gapmusic.db');
  if (fs.existsSync(dbFile)) {
    await ctx.replyWithDocument(
      { source: dbFile, filename: 'gapmusic.db' },
      { caption: `📦 بکاپ دیتابیس SQLite | کل آهنگ‌ها: ${DB.getStats().total_songs}` }
    );
  }
});

bot.action(/^admdel_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('فقط ادمین اجازه حذف دارد!', { show_alert: true });
  const songId = parseInt(ctx.match[1], 10);
  const removed = DB.deleteSong(songId);
  if (!removed) return ctx.answerCbQuery('قبلاً حذف شده است.', { show_alert: true });
  await ctx.answerCbQuery(`🗑️ آهنگ #${songId} حذف شد!`, { show_alert: true });
  await ctx.deleteMessage().catch(() => {});
});

bot.action('noop', (ctx) => ctx.answerCbQuery());

bot.action('main_menu', async (ctx) => {
  DB.registerUser(ctx.from);
  userSessions.delete(ctx.from.id);
  const { text, keyboard } = buildMainMenu(ctx.from.id);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard }).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('list_all', async (ctx) => {
  const result = DB.getSongs({ filter: 'all', limit: 60 });
  userSessions.set(ctx.from.id, { list: result.items.map(s => s.id) });
  await ctx.editMessageText(`🎵 کل موزیک‌های فعال (${result.total} ترک):`, buildSongListKeyboard(result.items, 0)).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('top_songs', async (ctx) => {
  const result = DB.getSongs({ filter: 'popular', limit: 60 });
  userSessions.set(ctx.from.id, { list: result.items.map(s => s.id) });
  await ctx.editMessageText('🔥 پرطرفدارترین موزیک‌ها:', buildSongListKeyboard(result.items, 0)).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('newest_songs', async (ctx) => {
  const result = DB.getSongs({ filter: 'newest', limit: 60 });
  userSessions.set(ctx.from.id, { list: result.items.map(s => s.id) });
  await ctx.editMessageText('🆕 جدیدترین موزیک‌های آرشیو:', buildSongListKeyboard(result.items, 0)).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('my_favorites', async (ctx) => {
  const favResult = DB.getUserFavorites(ctx.from.id);
  if (!favResult.items.length) {
    return ctx.answerCbQuery('پلی‌لیست شما خالی است! زیر آهنگ‌ها روی 🤍 بزنید.', { show_alert: true });
  }
  userSessions.set(ctx.from.id, { list: favResult.items.map(s => s.id) });
  await ctx.editMessageText(`❤️ پلی‌لیست شخصی شما (${favResult.items.length} ترک):`, buildSongListKeyboard(favResult.items, 0)).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('random_song', async (ctx) => {
  const song = DB.getRandomSong();
  if (!song) return ctx.answerCbQuery('آهنگی یافت نشد', { show_alert: true });
  await ctx.answerCbQuery('🎲 در حال ارسال موزیک شانسی...');
  await sendSongToChat(ctx, ctx.chat.id, song, ctx.from.id);
});

bot.action('request_song', async (ctx) => {
  userSessions.set(ctx.from.id, { awaitingRequest: true });
  await ctx.editMessageText(
    '📩 نام آهنگ و خواننده مورد نظر خود را تایپ و ارسال کنید:',
    Markup.inlineKeyboard([[Markup.button.callback('🔙 انصراف', 'main_menu')]])
  ).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action(/^dl_(\d+)$/, async (ctx) => {
  const songId = parseInt(ctx.match[1], 10);
  const song = DB.getSongById(songId);
  if (!song) return ctx.answerCbQuery('موزیک یافت نشد', { show_alert: true });
  await ctx.answerCbQuery('⏳ در حال آماده‌سازی و ارسال...');
  await sendSongToChat(ctx, ctx.chat.id, song, ctx.from.id);
});

bot.action(/^like_(\d+)$/, async (ctx) => {
  const songId = parseInt(ctx.match[1], 10);
  const { liked, likes } = DB.toggleFavorite(ctx.from.id, songId);
  const likeBtnText = liked ? `❤️ در پلی‌لیست (${likes})` : `🤍 افزودن به پلی‌لیست (${likes})`;

  const rows = [
    [
      Markup.button.callback(likeBtnText, `like_${songId}`),
      Markup.button.callback('🎲 آهنگ بعدی', 'random_song')
    ]
  ];
  if (isAdmin(ctx.from.id)) {
    rows.push([Markup.button.callback('🗑️ حذف این آهنگ (ادمین)', `admdel_${songId}`)]);
  }
  if (WEB_APP_URL) {
    rows.push([Markup.button.webApp('🎧 باز کردن پلیر مینی‌اپ', WEB_APP_URL)]);
  }
  await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(rows).reply_markup).catch(() => {});
  await ctx.answerCbQuery(liked ? '❤️ به پلی‌لیست اضافه شد!' : '💔 از پلی‌لیست حذف شد.');
});

bot.action(/^page_(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1], 10);
  const session = userSessions.get(ctx.from.id);
  if (!session || !session.list) {
    return ctx.answerCbQuery('نتایج منقضی شده‌اند، دوباره جستجو کنید.', { show_alert: true });
  }
  const songs = session.list.map(id => DB.getSongById(id)).filter(Boolean);
  await ctx.editMessageReplyMarkup(buildSongListKeyboard(songs, page).reply_markup).catch(() => {});
  await ctx.answerCbQuery();
});

bot.on(['audio', 'document', 'channel_post'], async (ctx, next) => {
  const msg = ctx.message || ctx.channelPost;
  if (!msg) return next();

  const audio = msg.audio || (msg.document && (msg.document.mime_type || '').startsWith('audio/') ? msg.document : null);
  if (!audio) return next();

  if (ctx.from) DB.registerUser(ctx.from);

  const rawTitle = audio.title || (audio.file_name ? path.parse(audio.file_name).name : 'نامشخص');
  const title = cleanDisplayText(rawTitle);
  const performer = cleanDisplayText(audio.performer || 'نامشخص');
  const normSearch = DB.expandBilingualTerms(`${title} ${performer}`);

  const exists = DB.findSongByUniqueIdOrSearch(audio.file_unique_id, normSearch);

  if (exists) {
    DB.updateSongFile(exists.id, {
      file_id: audio.file_id,
      file_unique_id: audio.file_unique_id || exists.file_unique_id,
      from_chat_id: ctx.chat.id,
      message_id: msg.message_id
    });

    notifyFulfilledRequests(exists).catch(() => {});

    if (!ctx.channelPost) {
      const dupMsg =
        `⚠️ این موزیک قبلاً در دیتابیس ثبت شده بود و بروزرسانی شد!\n\n` +
        `🎵 خواننده: ${exists.performer}\n` +
        `🎧 نام آهنگ: ${exists.title}\n` +
        `📌 کد ثبت شده: ${exists.id}`;
      await sendAutoDeleteReply(ctx, dupMsg, 5000);
    }
    return;
  }

  const newSong = DB.addSong({
    from_chat_id: ctx.chat.id,
    message_id: msg.message_id,
    file_id: audio.file_id,
    file_unique_id: audio.file_unique_id || '',
    title,
    performer,
    search_text: normSearch,
    media_type: msg.audio ? 'audio' : 'document'
  });

  notifyFulfilledRequests(newSong).catch(() => {});

  if (!ctx.channelPost) {
    const confirmMsg =
      `✅ موزیک با موفقیت در دیتابیس ذخیره شد!\n\n` +
      `🎵 خواننده: ${performer}\n` +
      `🎧 نام آهنگ: ${title}\n` +
      `📌 کد ثبت شده: ${newSong.id}`;

    await sendAutoDeleteReply(ctx, confirmMsg, 5000);
  }
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text || text.startsWith('/')) return;
  DB.registerUser(ctx.from);

  let query = text;
  if (ctx.chat.type !== 'private') {
    if (text.startsWith('موزیک ')) query = text.slice(6).trim();
    else return;
  }

  const session = userSessions.get(ctx.from.id);
  if (ctx.chat.type === 'private' && session?.awaitingRequest) {
    userSessions.delete(ctx.from.id);
    DB.addSongRequest(ctx.from.id, ctx.from.first_name, query);
    await ctx.reply(`✅ درخواست شما برای «${query}» ثبت شد و به ادمین ارسال گردید.\nبه محض آپلود، در پی‌وی به شما خبر می‌دهم!`);
    return;
  }

  const searchResult = DB.searchSongs(query, { limit: 60 });
  const results = searchResult.items;

  if (!results.length) {
    userSessions.set(ctx.from.id, { pendingQuery: query });
    return ctx.reply(
      `❌ آهنگی برای «${query}» یافت نشد.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('📩 ارسال درخواست برای ادمین', 'quick_request_pending')],
        [Markup.button.callback('🎲 موزیک شانسی', 'random_song')]
      ])
    );
  }

  userSessions.set(ctx.from.id, { list: results.map(s => s.id) });
  await ctx.reply(
    `🔍 نتایج جستجو برای «${query}» (${searchResult.total} ترک):`,
    buildSongListKeyboard(results, 0)
  );
});

bot.action('quick_request_pending', async (ctx) => {
  const session = userSessions.get(ctx.from.id);
  const q = session?.pendingQuery;
  if (!q) return ctx.answerCbQuery('لطفاً دوباره نام آهنگ را تایپ کنید.', { show_alert: true });
  userSessions.delete(ctx.from.id);
  DB.addSongRequest(ctx.from.id, ctx.from.first_name, q);
  await ctx.editMessageText(`✅ درخواست شما برای «${q}» به ادمین ارسال شد.\nبه محض آپلود شدن آهنگ، در پی‌وی به شما خبر می‌دهم!`).catch(() => {});
  await ctx.answerCbQuery('✅ درخواست ثبت شد!');
});

bot.on('inline_query', async (ctx) => {
  const rawQ = (ctx.inlineQuery.query || '').trim();
  const searchResult = rawQ && rawQ !== '.'
    ? DB.searchSongs(rawQ, { limit: 25 })
    : DB.getSongs({ filter: 'newest', limit: 25 });

  const results = searchResult.items.filter(s => s.file_id).map(s => ({
    type: 'audio',
    id: String(s.id),
    audio_file_id: s.file_id,
    caption: `🎵 ${s.performer} - ${s.title}`
  }));

  await ctx.answerInlineQuery(results, { cache_time: 5, is_personal: true });
});

// ---------------------------------------------------------------------------
// Express Server & APIs
// ---------------------------------------------------------------------------
const app = express();

// اتصال Webhook حتماً باید قبل از express.json() باشد!
if (MINI_APP_URL && MINI_APP_URL.startsWith('https://')) {
  app.use(bot.webhookCallback(WEBHOOK_PATH));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'templates')));
app.use(express.static(__dirname));

// مسیر عیب‌یابی برای بررسی وضعیت اتصال Webhook به تلگرام
app.get('/webhook-status', async (req, res) => {
  try {
    const info = await axios.get(`${TELEGRAM_API}/getWebhookInfo`);
    res.json({
      bot_username: BOT_USERNAME,
      configured_mini_app_url: MINI_APP_URL,
      telegram_webhook_info: info.data.result
    });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const templateHtml = path.join(__dirname, 'templates', 'index.html');
  const rootHtml = path.join(__dirname, 'index.html');
  if (fs.existsSync(templateHtml)) res.sendFile(templateHtml);
  else if (fs.existsSync(rootHtml)) res.sendFile(rootHtml);
  else res.send('<h1>GapMusic Mini App Active</h1>');
});

app.get('/api/config', (req, res) => {
  const userId = resolveUserId(req.query.init_data, req.query.user_id);
  const stats = DB.getStats();
  const savedUser = userId ? DB.getUser(userId) : null;
  res.json({
    bot_username: BOT_USERNAME,
    total_songs: stats.total_songs,
    total_users: stats.total_users,
    total_requests: stats.total_requests,
    is_admin: isAdmin(userId),
    user_name: savedUser?.name || ''
  });
});

app.get('/api/avatar/:userId', async (req, res) => {
  const uid = req.params.userId;
  if (!uid || uid === 'undefined') return res.status(404).end();

  try {
    const photosResp = await axios.get(`${TELEGRAM_API}/getUserProfilePhotos`, {
      params: { user_id: uid, limit: 1 },
      timeout: 8000
    });
    const photos = photosResp.data?.result?.photos;
    if (!photos || !photos.length || !photos[0].length) {
      return res.status(404).end();
    }
    const fileId = photos[0][0].file_id;
    const fileResp = await axios.get(`${TELEGRAM_API}/getFile`, {
      params: { file_id: fileId },
      timeout: 8000
    });
    const filePath = fileResp.data?.result?.file_path;
    if (!filePath) return res.status(404).end();

    const imgResp = await axios.get(`${TELEGRAM_FILE_API}/${filePath}`, {
      responseType: 'stream',
      timeout: 15000
    });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    imgResp.data.pipe(res);
  } catch (e) {
    res.status(404).end();
  }
});

app.get('/api/songs', (req, res) => {
  const rawQ = String(req.query.q || '').trim();
  const filter = req.query.filter || 'all';
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 60));

  const result = DB.getSongs({ query: rawQ, filter, offset, limit });
  const items = result.items.map(s => ({
    uid: s.uid,
    id: s.id,
    title: s.title,
    performer: s.performer,
    likes: s.likes || 0,
    plays: s.plays || 0
  }));

  res.json({
    total: result.total,
    offset: result.offset,
    limit: result.limit,
    has_more: result.has_more,
    items
  });
});

app.get('/api/lyrics', async (req, res) => {
  const title = String(req.query.title || '').trim();
  const artist = String(req.query.artist || '').trim();
  const cleanTitle = cleanDisplayText(title);
  const cleanArtist = cleanDisplayText(artist);

  if (!cleanTitle && !cleanArtist) {
    return res.status(400).json({ error: 'Title or artist required' });
  }

  const songKey = `${cleanArtist}_${cleanTitle}`.toLowerCase();
  const cached = DB.getCachedLyrics(songKey);
  if (cached && (cached.syncedLyrics || cached.plainLyrics)) {
    return res.json(cached);
  }

  try {
    const lrclibResp = await axios.get('https://lrclib.net/api/get', {
      params: { track_name: cleanTitle, artist_name: cleanArtist },
      timeout: 5000,
      headers: { 'User-Agent': 'GapMusic MiniApp (https://t.me/)' }
    });

    const data = lrclibResp.data;
    const syncedLyrics = data?.syncedLyrics || null;
    const plainLyrics = data?.plainLyrics || null;

    if (syncedLyrics || plainLyrics) {
      DB.saveCachedLyrics(songKey, syncedLyrics, plainLyrics);
      return res.json({ syncedLyrics, plainLyrics });
    }
  } catch (err) {
    try {
      const searchResp = await axios.get('https://lrclib.net/api/search', {
        params: { q: `${cleanArtist} ${cleanTitle}` },
        timeout: 5000,
        headers: { 'User-Agent': 'GapMusic MiniApp (https://t.me/)' }
      });
      const results = searchResp.data;
      if (Array.isArray(results) && results.length > 0) {
        const first = results[0];
        const syncedLyrics = first.syncedLyrics || null;
        const plainLyrics = first.plainLyrics || null;
        if (syncedLyrics || plainLyrics) {
          DB.saveCachedLyrics(songKey, syncedLyrics, plainLyrics);
          return res.json({ syncedLyrics, plainLyrics });
        }
      }
    } catch (e2) {}
  }

  res.json({ syncedLyrics: null, plainLyrics: null });
});

app.post('/api/request', async (req, res) => {
  const queryText = String(req.body?.query || '').trim();
  const userId = resolveUserId(req.body?.init_data, req.body?.user_id);
  const userName = String(req.body?.user_name || '').trim();

  if (!queryText) {
    return res.status(400).json({ detail: 'لطفاً نام آهنگ را وارد کنید.' });
  }
  if (!userId) {
    return res.status(400).json({ detail: 'برای ثبت درخواست، مینی‌اپ را از داخل تلگرام باز کنید.' });
  }

  DB.registerUser({ id: userId, first_name: userName });
  const created = DB.addSongRequest(userId, userName, queryText);

  const adminMsg =
    `📩 **درخواست موزیک جدید از مینی‌اپ/ربات**\n\n` +
    `🎵 آهنگ درخواستی: **${queryText}**\n` +
    `👤 درخواست‌کننده: ${userName} (\`${userId}\`)\n` +
    `🆔 کد درخواست: #${created?.id || '?'}\n\n` +
    `💡 به محض اینکه فایل این آهنگ را در پی‌وی ربات آپلود کنید، به صورت خودکار به کاربر اطلاع داده می‌شود!`;

  for (const adm of ADMIN_IDS) {
    axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: adm,
      text: adminMsg,
      parse_mode: 'Markdown'
    }).catch(() => {});
  }

  res.json({ status: 'ok', request: created });
});

app.delete('/api/admin/song/:id', (req, res) => {
  const userId = resolveUserId(req.body?.init_data || req.query.init_data, req.body?.user_id || req.query.user_id);
  if (!isAdmin(userId)) {
    return res.status(403).json({ detail: 'دسترسی غیرمجاز! فقط ادمین اجازه حذف دارد.' });
  }

  const songId = parseInt(req.params.id, 10);
  const removed = DB.deleteSong(songId);
  if (!removed) {
    return res.status(404).json({ detail: 'موزیک یافت نشد یا قبلاً حذف شده است.' });
  }

  res.json({
    status: 'ok',
    deleted: removed,
    remaining: DB.getStats().total_songs
  });
});

app.get('/api/cover', async (req, res) => {
  const title = String(req.query.title || '').trim();
  const artist = String(req.query.artist || '').trim();
  const query = `${artist !== 'نامشخص' ? artist : ''} ${title !== 'نامشخص' ? title : ''}`.trim();

  if (!query) return res.json({ artwork: null });
  if (COVER_CACHE.has(query)) return res.json({ artwork: COVER_CACHE.get(query) });

  try {
    const resp = await axios.get('https://itunes.apple.com/search', {
      params: { term: query, media: 'music', limit: 1 },
      timeout: 5000
    });
    const results = resp.data?.results || [];
    let artwork = null;
    if (results.length > 0 && results[0].artworkUrl100) {
      artwork = results[0].artworkUrl100.replace('100x100bb', '500x500bb');
    }
    COVER_CACHE.set(query, artwork);
    res.json({ artwork });
  } catch (e) {
    res.json({ artwork: null });
  }
});

app.get('/api/favorites', (req, res) => {
  const userId = resolveUserId(req.query.init_data, req.query.user_id);
  if (!userId) return res.json({ favorite_ids: [], items: [] });

  const favResult = DB.getUserFavorites(userId);
  res.json(favResult);
});

app.post('/api/favorite/:id', (req, res) => {
  const songId = parseInt(req.params.id, 10);
  const userId = resolveUserId(req.body.init_data, req.body.user_id);
  if (!userId) return res.status(400).json({ error: 'User ID required' });

  const result = DB.toggleFavorite(userId, songId);
  res.json({ status: 'ok', ...result });
});

app.get('/api/random', (req, res) => {
  const s = DB.getRandomSong();
  if (!s) return res.status(404).json({ detail: 'آهنگی یافت نشد' });
  res.json({
    uid: s.uid,
    id: s.id,
    title: s.title,
    performer: s.performer,
    likes: s.likes || 0
  });
});

app.get('/api/stream/:uid', async (req, res) => {
  const song = DB.getSongByUid(req.params.uid);
  if (!song) return res.status(404).json({ detail: 'موزیک یافت نشد' });

  const resolved = await resolvePlayableFile(song);
  if (!resolved || resolved.error || !resolved.filePath) {
    return res.status(404).json({
      detail: `خطای تلگرام: ${resolved?.error || 'فایل قابل استریم نیست'}`
    });
  }

  try {
    const fileUrl = `${resolved.fileApi || TELEGRAM_FILE_API}/${resolved.filePath}`;
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;

    const streamResp = await axios.get(fileUrl, {
      headers,
      responseType: 'stream',
      timeout: 60000,
      validateStatus: status => status >= 200 && status < 300
    });

    DB.incrementPlays(song.id);

    res.status(streamResp.status);
    res.setHeader('Content-Type', resolved.filePath.endsWith('.m4a') ? 'audio/mp4' : 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    if (req.query.download === '1') {
      const ext = resolved.filePath.endsWith('.m4a') ? 'm4a' : 'mp3';
      const cleanFilename = `${song.performer} - ${song.title}.${ext}`.replace(/[\\/:*?"<>|]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(cleanFilename)}`);
    }

    if (streamResp.headers['content-length']) {
      res.setHeader('Content-Length', streamResp.headers['content-length']);
    }
    if (streamResp.headers['content-range']) {
      res.setHeader('Content-Range', streamResp.headers['content-range']);
    }

    streamResp.data.pipe(res);
  } catch (err) {
    console.error('Stream Error:', err.message);
    if (!res.headersSent) res.status(500).json({ detail: 'خطا در پخش آنلاین' });
  }
});

app.post('/api/send/:uid', async (req, res) => {
  const song = DB.getSongByUid(req.params.uid);
  if (!song) return res.status(404).json({ detail: 'موزیک یافت نشد' });

  const deepLink = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=song_${song.id}` : '';
  const userId = resolveUserId(req.body.init_data, req.body.user_id);

  if (!userId) {
    return res.status(400).json({
      need_start: true,
      deep_link: deepLink,
      detail: 'لطفاً ابتدا ربات را در تلگرام استارت کنید.'
    });
  }

  const caption = `🎵 ${song.performer} - ${song.title}\n🎧 ارسال شده از مینی‌اپ GapMusic`;
  const resolved = await resolvePlayableFile(song, userId);

  if (resolved?.alreadyDelivered) {
    return res.json({ status: 'ok' });
  }

  if (resolved?.fileId) {
    try {
      const r = await axios.post(`${TELEGRAM_API}/sendAudio`, {
        chat_id: userId,
        audio: resolved.fileId,
        caption
      });
      if (r.data.ok) return res.json({ status: 'ok' });
    } catch (e1) {
      try {
        const r2 = await axios.post(`${TELEGRAM_API}/sendDocument`, {
          chat_id: userId,
          document: resolved.fileId,
          caption
        });
        if (r2.data.ok) return res.json({ status: 'ok' });
      } catch (e2) {}
    }
  }

  if (resolved?.filePath) {
    try {
      const fileUrl = `${resolved.fileApi || TELEGRAM_FILE_API}/${resolved.filePath}`;
      const r3 = await axios.post(`${TELEGRAM_API}/sendAudio`, {
        chat_id: userId,
        audio: fileUrl,
        caption
      });
      if (r3.data.ok) {
        if (r3.data.result?.audio?.file_id) {
          DB.updateSongFile(song.id, { file_id: r3.data.result.audio.file_id });
        }
        return res.json({ status: 'ok' });
      }
    } catch (e3) {
      console.error('Send via URL failed:', e3.response?.data || e3.message);
    }
  }

  if (song.from_chat_id && song.message_id) {
    try {
      const r4 = await axios.post(`${TELEGRAM_API}/copyMessage`, {
        chat_id: userId,
        from_chat_id: song.from_chat_id,
        message_id: song.message_id,
        caption
      });
      if (r4.data.ok) return res.json({ status: 'ok' });
    } catch (e4) {}
  }

  res.status(400).json({
    need_start: true,
    deep_link: deepLink,
    detail: `عدم دسترسی به فایل تلگرام: ${resolved?.error || 'فایل در دسترس نیست'}`
  });
});

// ---------------------------------------------------------------------------
// Start Server & Connect Telegram Bot
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 سرور مینی‌اپ روی پورت ${PORT} با پایگاه‌داده SQLite بالا آمد.`);

  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username || '';
    console.log(`🤖 نام کاربری ربات: @${BOT_USERNAME}`);
  } catch (e) {
    console.error(`⚠️ خطا در ارتباط اولیه با تلگرام: ${e.message}`);
  }

  if (WEB_APP_URL) {
    try {
      await bot.telegram.setChatMenuButton({
        menuButton: {
          type: 'web_app',
          text: 'Mini App',
          web_app: { url: WEB_APP_URL }
        }
      });
    } catch (e) {}
  }

  if (MINI_APP_URL && MINI_APP_URL.startsWith('https://')) {
    try {
      const fullWebhookUrl = `${MINI_APP_URL}${WEBHOOK_PATH}`;
      await bot.telegram.setWebhook(fullWebhookUrl, { drop_pending_updates: true });
      console.log(`✅ ربات تلگرام با موفقیت روی Webhook متصل شد: ${MINI_APP_URL}`);
    } catch (err) {
      console.error('⚠️ خطا در ثبت Webhook:', err.message);
    }
  } else {
    setTimeout(async () => {
      try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        await bot.launch();
        console.log('🤖 ربات تلگرام در حالت Polling آنلاین شد!');
      } catch (err) {
        console.error('⚠️ خطا در Polling:', err.message);
      }
    }, 3000);
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
