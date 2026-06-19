const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs-extra");
const path = require("path");

const BOT_TOKEN = "8980239383:AAFwZVEzP0lTYoIG3-HYig4xTz47L1n0lXY";
const ADMIN_ID = 7485181331;
const DATA_FILE = path.join(__dirname, "data.json");
const CHECK_INTERVAL = 15000; // 15 seconds

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── Data Storage ─────────────────────────────────────────────────────────────
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    return fs.readJsonSync(DATA_FILE);
  }
  return { approved: [], pending: {}, tracks: {} };
}

function saveData(data) {
  fs.writeJsonSync(DATA_FILE, data, { spaces: 2 });
}

let db = loadData();

function persist() {
  saveData(db);
}

// ─── Flipkart Scraper ─────────────────────────────────────────────────────────
async function scrapeFlipkart(url) {
  try {
    const cleanUrl = url.split("?")[0];
    const { data } = await axios.get(cleanUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept-Language": "en-IN,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(data);

    // Product name
    let name =
      $("span.VU-ZEz").first().text().trim() ||
      $("span.B_NuCI").first().text().trim() ||
      $("h1").first().text().trim() ||
      "Product";
    name = name.substring(0, 80);

    // Price to buy (not MRP)
    let price = null;
    const priceSelectors = [
      "div.Nx9bqj.CxhGGd",
      "div.Nx9bqj",
      "div._30jeq3._16Jk6d",
      "div._30jeq3",
      "div.aBc1ts",
      "div.CEmiEU",
    ];

    for (const sel of priceSelectors) {
      const el = $(sel).first();
      if (el.length) {
        const raw = el.text().replace(/[₹,\s]/g, "");
        const m = raw.match(/(\d+)/);
        if (m) {
          price = parseInt(m[1]);
          break;
        }
      }
    }

    // Fallback price from raw HTML
    if (!price) {
      const m = data.match(/₹[\s]?([\d,]+)/);
      if (m) price = parseInt(m[1].replace(/,/g, ""));
    }

    // Bank offers
    const offers = [];
    $("li").each((_, el) => {
      const txt = $(el).text().replace(/\s+/g, " ").trim();
      if (
        /bank|card|hdfc|sbi|icici|axis|kotak|cashback|discount|emi|instant/i.test(
          txt
        ) &&
        txt.length > 10 &&
        txt.length < 200
      ) {
        if (offers.length < 6) offers.push(txt.substring(0, 150));
      }
    });

    return { name, price, offers };
  } catch (err) {
    console.error("Scrape error:", err.message);
    return { name: null, price: null, offers: [] };
  }
}

// ─── Keyboards ────────────────────────────────────────────────────────────────
const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "➕ Track New Product", callback_data: "add_track" }],
      [{ text: "📋 My Active Tracks", callback_data: "list_tracks" }],
      [{ text: "🗑️ Remove a Track", callback_data: "remove_menu" }],
    ],
  },
};

const adminMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "📥 Pending Requests", callback_data: "admin_pending" }],
      [{ text: "✅ Approved Users", callback_data: "admin_approved" }],
    ],
  },
};

// Track who is waiting to submit a URL
const waitingForUrl = new Set();

// ─── /start Handler ───────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const uid = String(msg.from.id);
  const user = msg.from;

  if (parseInt(uid) === ADMIN_ID) {
    return bot.sendMessage(
      ADMIN_ID,
      "👑 *Admin Panel*\n\nWelcome back, Boss!",
      { parse_mode: "Markdown", ...adminMenu }
    );
  }

  if (db.approved.includes(uid)) {
    return bot.sendMessage(
      uid,
      "✅ *Flipkart Price Alert Bot*\n\nApka account approved hai! Kya track karna hai?",
      { parse_mode: "Markdown", ...mainMenu }
    );
  }

  // Send approval request to admin
  const name =
    `${user.first_name || ""} ${user.last_name || ""}`.trim() || "Unknown";
  const uname = user.username ? `@${user.username}` : "N/A";
  db.pending[uid] = { name, username: uname };
  persist();

  bot
    .sendMessage(
      ADMIN_ID,
      `🔔 *New User Request*\n\n👤 Name: ${name}\n🔗 Username: ${uname}\n🆔 ID: \`${uid}\``,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Approve", callback_data: `approve_${uid}` },
              { text: "❌ Reject", callback_data: `reject_${uid}` },
            ],
          ],
        },
      }
    )
    .catch(console.error);

  bot.sendMessage(
    uid,
    "⏳ *Request Sent!*\n\nAdmin review karega. Approve hone ke baad bot use kar sakte ho.",
    { parse_mode: "Markdown" }
  );
});

// ─── Callback Query Handler ───────────────────────────────────────────────────
bot.on("callback_query", async (q) => {
  const uid = String(q.from.id);
  const cb = q.data;
  const chatId = q.message.chat.id;
  const msgId = q.message.message_id;

  bot.answerCallbackQuery(q.id).catch(() => {});

  // ── Admin: approve ──────────────────────────────────────────────────────
  if (cb.startsWith("approve_")) {
    if (parseInt(uid) !== ADMIN_ID) return;
    const target = cb.split("_")[1];
    if (!db.approved.includes(target)) db.approved.push(target);
    delete db.pending[target];
    persist();
    bot.editMessageText(`✅ User \`${target}\` approved!`, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: "Markdown",
    });
    bot
      .sendMessage(
        parseInt(target),
        "🎉 *Request Approved!*\n\nAb aap bot use kar sakte ho. /start karo!",
        { parse_mode: "Markdown", ...mainMenu }
      )
      .catch(() => {});
    return;
  }

  // ── Admin: reject ───────────────────────────────────────────────────────
  if (cb.startsWith("reject_")) {
    if (parseInt(uid) !== ADMIN_ID) return;
    const target = cb.split("_")[1];
    delete db.pending[target];
    persist();
    bot.editMessageText(`❌ User \`${target}\` rejected.`, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: "Markdown",
    });
    bot
      .sendMessage(parseInt(target), "❌ Aapki request admin ne reject kar di.")
      .catch(() => {});
    return;
  }

  if (cb === "admin_pending") {
    if (parseInt(uid) !== ADMIN_ID) return;
    const pending = db.pending;
    if (!Object.keys(pending).length) {
      return bot.editMessageText("📭 No pending requests.", {
        chat_id: chatId,
        message_id: msgId,
        ...adminMenu,
      });
    }
    let text = "📥 *Pending Requests:*\n\n";
    const btns = [];
    for (const [tid, info] of Object.entries(pending)) {
      text += `👤 ${info.name} (${info.username}) — \`${tid}\`\n`;
      btns.push([
        { text: `✅ ${info.name}`, callback_data: `approve_${tid}` },
        { text: "❌", callback_data: `reject_${tid}` },
      ]);
    }
    btns.push([{ text: "🔙 Back", callback_data: "admin_back" }]);
    return bot.editMessageText(text, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: btns },
    });
  }

  if (cb === "admin_approved") {
    if (parseInt(uid) !== ADMIN_ID) return;
    const text = db.approved.length
      ? "✅ *Approved Users:*\n\n" + db.approved.map((u) => `\`${u}\``).join("\n")
      : "📭 No approved users yet.";
    return bot.editMessageText(text, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 Back", callback_data: "admin_back" }]],
      },
    });
  }

  if (cb === "admin_back") {
    if (parseInt(uid) !== ADMIN_ID) return;
    return bot.editMessageText("👑 *Admin Panel*", {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: "Markdown",
      ...adminMenu,
    });
  }

  // ── Check approved ──────────────────────────────────────────────────────
  if (!db.approved.includes(uid) && parseInt(uid) !== ADMIN_ID) {
    return bot.answerCallbackQuery(q.id, {
      text: "⛔ Access denied. Admin approval pending.",
      show_alert: true,
    });
  }

  // ── Add track ───────────────────────────────────────────────────────────
  if (cb === "add_track") {
    waitingForUrl.add(uid);
    return bot.editMessageText(
      "🔗 *Product URL Bhejo*\n\nFlipcart product ka link paste karo:",
      { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
    );
  }

  // ── List tracks ─────────────────────────────────────────────────────────
  if (cb === "list_tracks") {
    const userTracks = db.tracks[uid] || [];
    if (!userTracks.length) {
      return bot.editMessageText("📭 Koi active track nahi hai.", {
        chat_id: chatId,
        message_id: msgId,
        ...mainMenu,
      });
    }
    let text = "📋 *Active Tracks:*\n\n";
    userTracks.forEach((t, i) => {
      const ps = t.price ? `₹${t.price.toLocaleString("en-IN")}` : "N/A";
      text += `${i + 1}. *${t.name}*\n   💰 Last Price: ${ps}\n\n`;
    });
    return bot.editMessageText(text, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: "Markdown",
      ...mainMenu,
    });
  }

  // ── Remove menu ─────────────────────────────────────────────────────────
  if (cb === "remove_menu") {
    const userTracks = db.tracks[uid] || [];
    if (!userTracks.length) {
      return bot.editMessageText(
        "📭 Koi track nahi hai remove karne ke liye.",
        { chat_id: chatId, message_id: msgId, ...mainMenu }
      );
    }
    const btns = userTracks.map((t, i) => [
      { text: `🗑️ ${t.name.substring(0, 40)}`, callback_data: `del_${i}` },
    ]);
    btns.push([{ text: "🔙 Back", callback_data: "back_main" }]);
    return bot.editMessageText("🗑️ *Kaun sa remove karein?*", {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: btns },
    });
  }

  if (cb.startsWith("del_")) {
    const idx = parseInt(cb.split("_")[1]);
    const userTracks = db.tracks[uid] || [];
    if (idx >= 0 && idx < userTracks.length) {
      const [removed] = userTracks.splice(idx, 1);
      db.tracks[uid] = userTracks;
      persist();
      return bot.editMessageText(
        `✅ *${removed.name}* tracking se remove ho gaya!`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          ...mainMenu,
        }
      );
    }
  }

  if (cb === "back_main") {
    return bot.editMessageText(
      "✅ *Flipkart Price Alert Bot*\n\nKya track karna hai?",
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        ...mainMenu,
      }
    );
  }
});

// ─── Message Handler (URL input) ──────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const uid = String(msg.from.id);
  const text = msg.text.trim();

  if (!db.approved.includes(uid) && parseInt(uid) !== ADMIN_ID) {
    return bot.sendMessage(uid, "⛔ Access denied. Admin approval pending.");
  }

  if (waitingForUrl.has(uid)) {
    if (!text.includes("flipkart.com")) {
      return bot.sendMessage(uid, "❌ Valid Flipkart URL bhejo bhai!");
    }
    waitingForUrl.delete(uid);
    const loadMsg = await bot.sendMessage(uid, "⏳ Product check ho raha hai...");

    const { name, price, offers } = await scrapeFlipkart(text);

    if (!name) {
      return bot.editMessageText(
        "❌ Product fetch nahi ho paya. URL check karo.",
        { chat_id: uid, message_id: loadMsg.message_id }
      );
    }

    if (!db.tracks[uid]) db.tracks[uid] = [];
    db.tracks[uid].push({ url: text, name, price, offers });
    persist();

    const ps = price ? `₹${price.toLocaleString("en-IN")}` : "N/A";
    const offerStr = offers.length
      ? offers.map((o) => `• ${o}`).join("\n")
      : "No offers found";

    return bot.editMessageText(
      `✅ *Tracking Started!*\n\n📦 ${name}\n💰 Current Price: *${ps}*\n\n🏦 Bank Offers:\n${offerStr}\n\n_Har 15 sec mein check hoga!_`,
      {
        chat_id: uid,
        message_id: loadMsg.message_id,
        parse_mode: "Markdown",
        ...mainMenu,
      }
    );
  }

  bot.sendMessage(uid, "👋 Menu ke liye /start use karo.", mainMenu);
});

// ─── Background Price Checker ─────────────────────────────────────────────────
async function checkPrices() {
  for (const [uid, userTracks] of Object.entries(db.tracks)) {
    for (const track of userTracks) {
      if (!track.url) continue;
      try {
        const { name, price: newPrice, offers: newOffers } = await scrapeFlipkart(track.url);
        if (!name) continue;

        const oldPrice = track.price;
        const oldOffers = track.offers || [];
        const alertParts = [];

        if (newPrice && oldPrice && newPrice !== oldPrice) {
          const diff = oldPrice - newPrice;
          const arrow = diff > 0 ? "📉" : "📈";
          const word = diff > 0 ? "SASTA HO GAYA" : "MAHANGA HO GAYA";
          alertParts.push(
            `${arrow} *Price ${word}!*\n   Old: ₹${oldPrice.toLocaleString("en-IN")}\n   New: ₹${newPrice.toLocaleString("en-IN")}\n   Change: ₹${Math.abs(diff).toLocaleString("en-IN")}`
          );
          track.price = newPrice;
        }

        const addedOffers = newOffers.filter((o) => !oldOffers.includes(o));
        const removedOffers = oldOffers.filter((o) => !newOffers.includes(o));

        if (addedOffers.length) {
          alertParts.push(
            "🆕 *Naye Bank Offers:*\n" + addedOffers.map((o) => `• ${o}`).join("\n")
          );
          track.offers = newOffers;
        }
        if (removedOffers.length) {
          alertParts.push(
            "⛔ *Removed Offers:*\n" + removedOffers.map((o) => `• ${o}`).join("\n")
          );
          track.offers = newOffers;
        }

        if (alertParts.length) {
          persist();
          const msg =
            `🚨 *ALERT — ${track.name}*\n\n` +
            alertParts.join("\n\n") +
            `\n\n[🔗 Product Link](${track.url})`;
          bot
            .sendMessage(parseInt(uid), msg, {
              parse_mode: "Markdown",
              disable_web_page_preview: true,
            })
            .catch(console.error);
        }
      } catch (err) {
        console.error(`Check error for ${uid}:`, err.message);
      }
    }
  }
}

setInterval(checkPrices, CHECK_INTERVAL);

console.log("🤖 Flipkart Price Alert Bot running...");
console.log(`✅ Checking every ${CHECK_INTERVAL / 1000}s`);
