// telegram-gift-bot.js - TO'LIQ TUZATILGAN VA XAVFSIZ VERSIYA

const { Telegraf, Markup, session } = require("telegraf");
const Database = require("better-sqlite3");
const fs = require("fs");
require("dotenv").config();

// ==================== KONFIGURATSIYA ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS
  ? process.env.ADMIN_IDS.split(",").map((id) => parseInt(id.trim()))
  : [];
const BOT_USERNAME = process.env.BOT_USERNAME || "bzc_coinbot";
const REQUIRED_CHANNEL = process.env.REQUIRED_CHANNEL || "";
const CHANNEL_URL = process.env.CHANNEL_URL || "";

const REFERRAL_BONUS = 20;
const JOIN_BONUS = 20;
const BROADCAST_DELAY = 1000;
const MAX_COIN_VALUE = 1000000;

// ==================== DATABASE ====================
const db = new Database("gift_bot.db");

const initDatabase = () => {
  db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id INTEGER UNIQUE NOT NULL,
            username TEXT DEFAULT '',
            first_name TEXT DEFAULT '',
            balance INTEGER DEFAULT 0 CHECK(balance >= 0),
            total_coins INTEGER DEFAULT 0,
            is_admin INTEGER DEFAULT 0,
            is_subscribed INTEGER DEFAULT 0,
            referred_by INTEGER DEFAULT 0,
            referrals_count INTEGER DEFAULT 0,
            referral_received INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
        CREATE INDEX IF NOT EXISTS idx_users_balance ON users(balance);
        
        CREATE TABLE IF NOT EXISTS promo_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL COLLATE NOCASE,
            value INTEGER NOT NULL CHECK(value > 0),
            is_used INTEGER DEFAULT 0,
            used_by INTEGER,
            created_by INTEGER,
            used_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);
        
        CREATE TABLE IF NOT EXISTS groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER UNIQUE NOT NULL,
            group_title TEXT,
            added_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

  for (const adminId of ADMIN_IDS) {
    if (!isNaN(adminId) && adminId > 0) {
      const existing = db
        .prepare("SELECT * FROM users WHERE telegram_id = ?")
        .get(adminId);
      if (!existing) {
        db.prepare(
          "INSERT INTO users (telegram_id, username, is_admin, balance, referral_received, is_subscribed) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(adminId, "admin", 1, 0, 1, 1);
      } else {
        db.prepare("UPDATE users SET is_admin = 1 WHERE telegram_id = ?").run(
          adminId,
        );
      }
    }
  }

  console.log("✅ Database ready");
  console.log("👑 Admin IDs:", ADMIN_IDS);
};

// ==================== XAVFSIZLIK FUNKSIYALARI ====================
const sanitizeId = (id) => {
  const parsed = parseInt(id);
  return isNaN(parsed) || parsed <= 0 ? null : parsed;
};

const sanitizeAmount = (amount) => {
  const parsed = parseInt(amount);
  return isNaN(parsed) || parsed <= 0 || parsed > MAX_COIN_VALUE
    ? null
    : parsed;
};

const sanitizeText = (text) => {
  if (!text || typeof text !== "string") return "";
  return text.replace(/[<>]/g, "").substring(0, 100);
};

const validateCode = (code) => {
  return code && /^\d+$/.test(code) && code.length >= 4 && code.length <= 10;
};

const isAdminUser = (userId) => {
  const user = db
    .prepare("SELECT is_admin FROM users WHERE telegram_id = ?")
    .get(userId);
  if (user) return user.is_admin === 1;
  return ADMIN_IDS.includes(userId);
};

// ==================== ATOMIK TRANZAKSIYALAR ====================
const usePromoCode = db.transaction((code, userId, username) => {
  const promo = db
    .prepare(
      "SELECT * FROM promo_codes WHERE code = ? COLLATE NOCASE AND is_used = 0",
    )
    .get(code);

  if (!promo) {
    return { success: false, error: "not_found" };
  }

  db.prepare(
    `UPDATE promo_codes SET is_used = 1, used_by = ?, used_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).run(userId, promo.id);

  db.prepare(
    `UPDATE users SET balance = balance + ?, total_coins = total_coins + ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?`,
  ).run(promo.value, promo.value, userId);

  const newBalance = db
    .prepare("SELECT balance FROM users WHERE telegram_id = ?")
    .get(userId).balance;

  return {
    success: true,
    value: promo.value,
    code: promo.code,
    newBalance: newBalance,
  };
});

const processReferral = db.transaction((referrerId, newUserId) => {
  const referrer = db
    .prepare("SELECT * FROM users WHERE telegram_id = ?")
    .get(referrerId);
  if (referrer && referrer.referral_received === 0) {
    db.prepare(
      `UPDATE users SET balance = balance + ?, total_coins = total_coins + ?, referrals_count = referrals_count + 1, referral_received = 1 WHERE telegram_id = ?`,
    ).run(REFERRAL_BONUS, REFERRAL_BONUS, referrerId);

    db.prepare(
      `UPDATE users SET balance = balance + ?, total_coins = total_coins + ? WHERE telegram_id = ?`,
    ).run(JOIN_BONUS, JOIN_BONUS, newUserId);

    return true;
  }
  return false;
});

const adminUpdateBalance = db.transaction((userId, amount, isAdd) => {
  const user = db
    .prepare("SELECT balance FROM users WHERE telegram_id = ?")
    .get(userId);
  if (!user) return { success: false, error: "user_not_found" };

  if (!isAdd && user.balance < amount) {
    return { success: false, error: "insufficient_balance" };
  }

  const finalAmount = isAdd ? amount : -amount;
  db.prepare(
    `UPDATE users SET balance = balance + ?, total_coins = total_coins + ? WHERE telegram_id = ?`,
  ).run(finalAmount, isAdd ? amount : 0, userId);

  const newBalance = db
    .prepare("SELECT balance FROM users WHERE telegram_id = ?")
    .get(userId).balance;
  return { success: true, newBalance: newBalance };
});

// ==================== KANAL OBUNASI ====================
const checkSubscription = async (userId) => {
  if (!REQUIRED_CHANNEL || REQUIRED_CHANNEL === "") return true;

  try {
    const chatMember = await bot.telegram.getChatMember(
      REQUIRED_CHANNEL,
      userId,
    );
    const status = chatMember.status;
    const isSubscribed =
      status === "member" || status === "administrator" || status === "creator";

    if (isSubscribed) {
      db.prepare(
        "UPDATE users SET is_subscribed = 1 WHERE telegram_id = ?",
      ).run(userId);
    }
    return isSubscribed;
  } catch (error) {
    return false;
  }
};

const sendSubscriptionRequired = async (ctx) => {
  const channelLink =
    CHANNEL_URL || `https://t.me/${REQUIRED_CHANNEL.replace("@", "")}`;
  await ctx.reply(
    `⚠️ DIQQAT! ⚠️\n\nBotdan foydalanish uchun quyidagi kanalga obuna bo'lishingiz SHART!\n\n📢 Kanal: ${REQUIRED_CHANNEL}\n\n👇 Obuna bo'ling va /start bosing 👇`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📢 Kanalga obuna bo'lish", url: channelLink }],
          [{ text: "✅ Obuna bo'ldim", callback_data: "check_sub" }],
        ],
      },
    },
  );
};

// ==================== FOYDALANUVCHI ====================
const findOrCreateUser = (telegramId, username, firstName) => {
  let user = db
    .prepare("SELECT * FROM users WHERE telegram_id = ?")
    .get(telegramId);

  if (!user) {
    const isAdmin = ADMIN_IDS.includes(telegramId) ? 1 : 0;
    db.prepare(
      `INSERT INTO users (telegram_id, username, first_name, is_admin, balance, referred_by, is_subscribed) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      telegramId,
      sanitizeText(username),
      sanitizeText(firstName),
      isAdmin,
      0,
      0,
      0,
    );
    user = db
      .prepare("SELECT * FROM users WHERE telegram_id = ?")
      .get(telegramId);
  }
  return user;
};

// ==================== BOT ====================
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// Global middleware
bot.use(async (ctx, next) => {
  try {
    if (ctx.from) {
      findOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
    }
    await next();
  } catch (error) {
    console.error("Middleware error:", error);
  }
});

// Admin middleware
const adminOnly = (ctx, next) => {
  if (!isAdminUser(ctx.from.id)) {
    return ctx.reply("❌ Bu buyruq faqat adminlar uchun!");
  }
  return next();
};

// ==================== KOMANDALAR ====================

bot.start(async (ctx) => {
  try {
    const userId = ctx.from.id;
    const startPayload = ctx.startPayload || "";

    if (startPayload && startPayload.startsWith("ref_")) {
      const referrerId = sanitizeId(startPayload.replace("ref_", ""));
      if (referrerId && referrerId !== userId) {
        const user = db
          .prepare("SELECT referred_by FROM users WHERE telegram_id = ?")
          .get(userId);
        if (!user || user.referred_by === 0) {
          db.prepare(
            "UPDATE users SET referred_by = ? WHERE telegram_id = ?",
          ).run(referrerId, userId);
          processReferral(referrerId, userId);
        }
      }
    }

    if (!isAdminUser(userId) && REQUIRED_CHANNEL) {
      const isSubscribed = await checkSubscription(userId);
      if (!isSubscribed) return sendSubscriptionRequired(ctx);
    }

    const user = db
      .prepare("SELECT * FROM users WHERE telegram_id = ?")
      .get(userId);

    await ctx.reply(
      `🎉 Xush kelibsiz, ${sanitizeText(ctx.from.first_name)}!\n\n` +
        `💰 Balans: ${user.balance.toLocaleString()} Coin\n` +
        `👥 Takliflar: ${user.referrals_count} ta\n\n` +
        `👇 Quyidagi tugmalardan foydalaning:`,
      Markup.keyboard([
        ["🎁 Bonus olish", "👤 Profilim"],
        ["👥 Do'st taklif qilish"],
      ]).resize(),
    );
  } catch (error) {
    console.error("Start error:", error);
    await ctx.reply("❌ Xatolik yuz berdi. Qayta urinib ko'ring.");
  }
});

bot.command("admin", adminOnly, async (ctx) => {
  await ctx.reply(
    "👑 ADMIN PANEL\n\nAmalni tanlang:",
    Markup.inlineKeyboard([
      [Markup.button.callback("➕ Kod yaratish", "create_code")],
      [Markup.button.callback("📋 Kodlar", "list_codes")],
      [Markup.button.callback("❌ Kod o'chirish", "delete_code")],
      [Markup.button.callback("👥 Foydalanuvchilar", "list_users")],
      [Markup.button.callback("💰 Coin qo'shish", "add_coin")],
      [Markup.button.callback("💸 Coin ayirish", "remove_coin")],
      [Markup.button.callback("📊 Statistika", "stats")],
      [Markup.button.callback("📢 Xabar yuborish", "broadcast")],
      [Markup.button.callback("📋 Guruhlar", "list_groups")],
    ]),
  );
});

// ==================== CALLBACK LAR ====================

bot.action("check_sub", async (ctx) => {
  await ctx.answerCbQuery("Tekshirilmoqda...");
  const isSubscribed = await checkSubscription(ctx.from.id);

  if (isSubscribed) {
    await ctx.reply("✅ Obuna bo'ldingiz! /start bosing.");
    try {
      await ctx.deleteMessage();
    } catch (e) {}
  } else {
    await ctx.reply("❌ Siz hali obuna bo'lmagansiz!");
  }
});

bot.action("create_code", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { action: "create_code" };
  await ctx.reply(
    "✏️ Kod qiymatini kiriting (1-1,000,000 Coin):\n\nMasalan: 500",
  );
});

bot.action("list_codes", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();
  const codes = db
    .prepare("SELECT * FROM promo_codes ORDER BY created_at DESC")
    .all();

  if (codes.length === 0) return ctx.reply("📭 Hech qanday kod yo'q");

  let msg = "📋 PROMO-KODLAR\n\n";
  codes.forEach((c, i) => {
    msg += `${i + 1}. Kod: ${c.code}\n   Qiymat: ${c.value.toLocaleString()} Coin\n`;
    msg += `   Holat: ${c.is_used ? "❌ Ishlatilgan" : "✅ Faol"}\n`;
    if (c.is_used) msg += `   Ishlatgan: ${c.used_by}\n`;
    msg += `\n`;
  });
  await ctx.reply(msg);
});

bot.action("delete_code", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();
  const codes = db.prepare("SELECT * FROM promo_codes WHERE is_used = 0").all();

  if (codes.length === 0) return ctx.reply("📭 O'chirish uchun faol kod yo'q");

  const buttons = codes.map((code) => [
    Markup.button.callback(`🗑 ${code.code} (${code.value})`, `del_${code.id}`),
  ]);
  buttons.push([Markup.button.callback("❌ Bekor", "cancel")]);

  await ctx.reply(
    "🗑 O'chiriladigan kodni tanlang:",
    Markup.inlineKeyboard(buttons),
  );
});

bot.action(/del_(\d+)/, adminOnly, async (ctx) => {
  const id = sanitizeId(ctx.match[1]);
  if (!id) return ctx.answerCbQuery("Xato ID");

  const code = db.prepare("SELECT * FROM promo_codes WHERE id = ?").get(id);
  if (code) {
    db.prepare("DELETE FROM promo_codes WHERE id = ?").run(id);
    await ctx.answerCbQuery(`✅ ${code.code} o\'chirildi`);
    await ctx.editMessageText(
      `✅ KOD O'CHIRILDI!\n\n🔑 ${code.code}\n💰 ${code.value.toLocaleString()} Coin`,
    );
  }
});

bot.action("list_users", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();
  const users = db
    .prepare(
      "SELECT * FROM users ORDER BY referrals_count DESC, balance DESC LIMIT 50",
    )
    .all();

  if (users.length === 0) return ctx.reply("📭 Foydalanuvchilar yo'q");

  let msg = "👥 TOP 50 FOYDALANUVCHI\n\n";
  users.forEach((u, i) => {
    msg += `${i + 1}. ${u.first_name || u.username || "No name"}\n`;
    msg += `   ID: ${u.telegram_id}\n`;
    msg += `   💰 ${u.balance.toLocaleString()} Coin\n`;
    msg += `   👥 ${u.referrals_count} ta taklif\n\n`;
  });
  await ctx.reply(msg);
});

bot.action("add_coin", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { action: "add_coin" };
  await ctx.reply(
    "💰 COIN QO'SHISH\n\nFormat: `user_id miqdor`\n\nMisol: `123456789 100`",
    { parse_mode: "Markdown" },
  );
});

bot.action("remove_coin", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { action: "remove_coin" };
  await ctx.reply(
    "💸 COIN AYIRISH\n\nFormat: `user_id miqdor`\n\nMisol: `123456789 50`",
    { parse_mode: "Markdown" },
  );
});

bot.action("stats", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();

  const userCount = db
    .prepare("SELECT COUNT(*) as count FROM users")
    .get().count;
  const subscribedCount = db
    .prepare("SELECT COUNT(*) as count FROM users WHERE is_subscribed = 1")
    .get().count;
  const totalCoins = db
    .prepare("SELECT COALESCE(SUM(balance), 0) as total FROM users")
    .get().total;
  const totalReferrals = db
    .prepare("SELECT COALESCE(SUM(referrals_count), 0) as total FROM users")
    .get().total;
  const codeCount = db
    .prepare("SELECT COUNT(*) as count FROM promo_codes")
    .get().count;
  const usedCodes = db
    .prepare("SELECT COUNT(*) as count FROM promo_codes WHERE is_used = 1")
    .get().count;
  const groupCount = db
    .prepare("SELECT COUNT(*) as count FROM groups")
    .get().count;

  await ctx.reply(
    `📊 STATISTIKA\n\n` +
      `👥 Foydalanuvchilar: ${userCount.toLocaleString()}\n` +
      `✅ Obuna: ${subscribedCount.toLocaleString()}\n` +
      `💰 Jami coin: ${totalCoins.toLocaleString()}\n` +
      `👥 Takliflar: ${totalReferrals.toLocaleString()}\n` +
      `🎫 Kodlar: ${codeCount} (${usedCodes} ishlatilgan)\n` +
      `👥 Guruhlar: ${groupCount}`,
  );
});

bot.action("broadcast", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { action: "broadcast" };
  await ctx.reply(
    "📢 GURUHLARGA XABAR YUBORISH\n\nBotga video, rasm yoki fayl yuboring, avtomatik barcha guruhlarga tarqatiladi.",
  );
});

bot.action("list_groups", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();
  const groups = db.prepare("SELECT * FROM groups LIMIT 50").all();

  if (groups.length === 0)
    return ctx.reply("📭 Bot hech qanday guruhga qo'shilmagan!");

  let msg = "👥 BOT ULANGAN GURUHLAR\n\n";
  groups.forEach((g, i) => {
    msg += `${i + 1}. ${g.group_title}\n   ID: ${g.group_id}\n\n`;
  });
  await ctx.reply(msg);
});

bot.action("cancel", adminOnly, async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {};
  await ctx.editMessageText("❌ Bekor qilindi");
});

// ==================== MATN QABUL QILISH ====================
bot.on("text", async (ctx) => {
  try {
    const text = ctx.message.text;
    const userId = ctx.from.id;

    // Obuna tekshiruvi
    if (!isAdminUser(userId) && REQUIRED_CHANNEL) {
      const isSubscribed = await checkSubscription(userId);
      if (!isSubscribed) return sendSubscriptionRequired(ctx);
    }

    // Do'st taklif qilish
    if (text === "👥 Do'st taklif qilish") {
      const user = db
        .prepare("SELECT referrals_count FROM users WHERE telegram_id = ?")
        .get(userId);
      const link = `https://t.me/${BOT_USERNAME}?start=ref_${userId}`;

      await ctx.reply(
        `👥 DO'STLARINGIZNI TAKLIF QILING\n\n` +
          `💰 Taklif bonusi: +${REFERRAL_BONUS} Coin\n` +
          `🎁 Do'stingizga: +${JOIN_BONUS} Coin\n\n` +
          `📊 Siz ${user.referrals_count} ta do'st taklif qilgansiz\n\n` +
          `🔗 Taklif linkingiz:\n${link}\n\n` +
          `Do'stlaringizga yuboring!`,
      );
      return;
    }

    // Kod yaratish (admin)
    if (ctx.session?.action === "create_code" && isAdminUser(userId)) {
      const value = sanitizeAmount(text);
      if (!value) {
        await ctx.reply("❌ Noto'g'ri! 1-1,000,000 oralig'ida son kiriting.");
        return;
      }

      const code = Math.floor(100000 + Math.random() * 900000).toString();
      db.prepare(
        "INSERT INTO promo_codes (code, value, created_by) VALUES (?, ?, ?)",
      ).run(code, value, userId);
      await ctx.reply(
        `✅ KOD YARATILDI!\n\n🔑 Kod: ${code}\n💰 Qiymat: ${value.toLocaleString()} Coin`,
      );
      ctx.session = {};
      return;
    }

    // Coin qo'shish (admin)
    if (ctx.session?.action === "add_coin" && isAdminUser(userId)) {
      const parts = text.split(" ");
      const targetUserId = sanitizeId(parts[0]);
      const amount = sanitizeAmount(parts[1]);

      if (!targetUserId || !amount) {
        await ctx.reply("❌ Format: user_id miqdor\nMisol: 123456789 100");
        return;
      }

      const result = adminUpdateBalance(targetUserId, amount, true);
      if (!result.success) {
        await ctx.reply(`❌ Foydalanuvchi topilmadi!`);
        return;
      }

      const user = db
        .prepare("SELECT first_name, username FROM users WHERE telegram_id = ?")
        .get(targetUserId);
      await ctx.reply(
        `✅ COIN QO'SHILDI!\n\n👤 ${user.first_name || user.username}\n🆔 ${targetUserId}\n➕ +${amount.toLocaleString()} Coin\n💰 Yangi balans: ${result.newBalance.toLocaleString()} Coin`,
      );
      ctx.session = {};
      return;
    }

    // Coin ayirish (admin)
    if (ctx.session?.action === "remove_coin" && isAdminUser(userId)) {
      const parts = text.split(" ");
      const targetUserId = sanitizeId(parts[0]);
      const amount = sanitizeAmount(parts[1]);

      if (!targetUserId || !amount) {
        await ctx.reply("❌ Format: user_id miqdor\nMisol: 123456789 50");
        return;
      }

      const result = adminUpdateBalance(targetUserId, amount, false);
      if (!result.success) {
        if (result.error === "user_not_found") {
          await ctx.reply(`❌ Foydalanuvchi topilmadi!`);
        } else {
          await ctx.reply(`❌ Balansda yetarli coin yo'q!`);
        }
        return;
      }

      const user = db
        .prepare("SELECT first_name, username FROM users WHERE telegram_id = ?")
        .get(targetUserId);
      await ctx.reply(
        `✅ COIN AYIRILDI!\n\n👤 ${user.first_name || user.username}\n🆔 ${targetUserId}\n➖ -${amount.toLocaleString()} Coin\n💰 Yangi balans: ${result.newBalance.toLocaleString()} Coin`,
      );
      ctx.session = {};
      return;
    }

    // Bonus olish
    if (text === "🎁 Bonus olish") {
      ctx.session = { waitingCode: true };
      await ctx.reply("🔑 PROMO-KODNI YUBORING\n\nMisol: 777777");
      return;
    }

    // Profilim
    if (text === "👤 Profilim") {
      const user = db
        .prepare("SELECT * FROM users WHERE telegram_id = ?")
        .get(userId);
      const rank = db
        .prepare("SELECT COUNT(*) + 1 as rank FROM users WHERE balance > ?")
        .get(user.balance).rank;
      const totalUsers = db
        .prepare("SELECT COUNT(*) as count FROM users")
        .get().count;

      await ctx.reply(
        `👤 PROFILIM\n\n` +
          `🆔 ID: ${userId}\n` +
          `👤 Ism: ${sanitizeText(ctx.from.first_name)}\n` +
          `💰 Balans: ${user.balance.toLocaleString()} Coin\n` +
          `📈 Jami yig'ilgan: ${user.total_coins.toLocaleString()} Coin\n` +
          `👥 Taklif qilganlar: ${user.referrals_count} ta\n` +
          `🏆 Reyting: ${rank}/${totalUsers}\n` +
          `📅 Qo'shilgan: ${new Date(user.created_at).toLocaleDateString()}`,
      );
      return;
    }

    // Promo-kodni tekshirish
    if (ctx.session?.waitingCode) {
      ctx.session.waitingCode = false;
      const code = text.trim().toUpperCase();

      if (!validateCode(code)) {
        await ctx.reply(
          "❌ Kod 4-10 raqamdan iborat bo'lishi kerak!\n\nMisol: 777777",
        );
        return;
      }

      const result = usePromoCode(code, userId, ctx.from.username);

      if (!result.success) {
        await ctx.reply(
          `❌ KOD TOPILMADI YOKI ISHLATILGAN!\n\n🔍 Iltimos, kodni tekshirib qayta urining.`,
        );
        return;
      }

      await ctx.reply(
        `🎉 TABRIKLAYMIZ! 🎉\n\n` +
          `✨ Sizga ${result.value.toLocaleString()} Bozorchi Coin berildi!\n` +
          `💰 Yangi balans: ${result.newBalance.toLocaleString()} Coin`,
      );
      return;
    }
  } catch (error) {
    console.error("Text handler error:", error);
    await ctx.reply("❌ Xatolik yuz berdi. Qayta urinib ko'ring.");
  }
});

// ==================== BROADCAST ====================
const broadcastMessage = async (ctx, fileId, type, caption) => {
  const groups = db.prepare("SELECT group_id, group_title FROM groups").all();

  if (groups.length === 0) {
    return ctx.reply("❌ Bot hech qanday guruhga qo'shilmagan!");
  }

  await ctx.reply(
    `📤 Xabar ${groups.length} ta guruhga yuborilmoqda...\n⏳ Iltimos kuting...`,
  );

  let success = 0;
  let fail = 0;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    try {
      if (type === "video") {
        await ctx.telegram.sendVideo(group.group_id, fileId, {
          caption: caption || "🎁 Yangi kontent!",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Botga Kirish",
                  url: `https://t.me/${BOT_USERNAME}?start=bonus`,
                },
              ],
            ],
          },
        });
      } else if (type === "photo") {
        await ctx.telegram.sendPhoto(group.group_id, fileId, {
          caption: caption || "🎁 Yangi kontent!",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Botga Kirish",
                  url: `https://t.me/${BOT_USERNAME}?start=bonus`,
                },
              ],
            ],
          },
        });
      } else if (type === "document") {
        await ctx.telegram.sendDocument(group.group_id, fileId, {
          caption: caption || "🎁 Yangi kontent!",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Botga Kirish",
                  url: `https://t.me/${BOT_USERNAME}?start=bonus`,
                },
              ],
            ],
          },
        });
      }
      success++;
    } catch (error) {
      fail++;
    }

    if ((i + 1) % 5 === 0) {
      await new Promise((resolve) => setTimeout(resolve, BROADCAST_DELAY));
    }
  }

  await ctx.reply(
    `✅ XABAR YUBORILDI!\n\n✅ Muvaffaqiyatli: ${success}\n❌ Xatolik: ${fail}`,
  );
};

bot.on("video", adminOnly, async (ctx) => {
  await broadcastMessage(
    ctx,
    ctx.message.video.file_id,
    "video",
    ctx.message.caption,
  );
  ctx.session = {};
});

bot.on("photo", adminOnly, async (ctx) => {
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  await broadcastMessage(ctx, photo.file_id, "photo", ctx.message.caption);
  ctx.session = {};
});

bot.on("document", adminOnly, async (ctx) => {
  await broadcastMessage(
    ctx,
    ctx.message.document.file_id,
    "document",
    ctx.message.caption,
  );
  ctx.session = {};
});

// ==================== GURUHGA QO'SHILISH ====================
bot.on("my_chat_member", async (ctx) => {
  const chat = ctx.myChatMember.chat;
  if (chat.type === "group" || chat.type === "supergroup") {
    const existing = db
      .prepare("SELECT * FROM groups WHERE group_id = ?")
      .get(chat.id);
    if (!existing) {
      db.prepare(
        "INSERT INTO groups (group_id, group_title) VALUES (?, ?)",
      ).run(chat.id, chat.title);
      console.log(`✅ Bot qo'shildi: ${chat.title}`);
    }
  }
});

// ==================== ERROR HANDLER ====================
bot.catch((err, ctx) => {
  console.error("Bot xatosi:", err.message);
  ctx.reply("❌ Xatolik yuz berdi. Qayta urinib ko'ring.").catch(() => {});
});

// ==================== START ====================
initDatabase();

bot.launch().then(() => {
  console.log("\n🚀 BOT ISHGA TUSHDI!");
  console.log("👑 Admin ID:", ADMIN_IDS);
  console.log("📌 Bot username: @" + BOT_USERNAME);
  console.log("\n📌 ADMIN PANEL: /admin");
  console.log("\n✅ BARCHA FUNKSIYALAR ISHLAYDI!");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
