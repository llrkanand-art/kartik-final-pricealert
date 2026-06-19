const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs-extra");
const path = require("path");
const http = require("http");

// ⚠️ APNA BOT TOKEN IN ENVIRONMENT VARIABLES ME RAKHEIN, HARDCODE NA KAREIN
const BOT_TOKEN = process.env.BOT_TOKEN || "8499624263:AAEQuPqkuqzKbb8Bq6P8jttROkqK9zGq0Lg";
const ADMIN_ID = "7485181331"; // Handle as String to prevent type mismatch
const DATA_FILE = path.join(__dirname, "data.json");
const CHECK_INTERVAL = 15000;

// ─── Keep-Alive Server ────────────────────────────────────────────────────────
http.createServer((req, res) => res.end("Bot is alive!")).listen(process.env.PORT || 3000);

// ─── Bot Init ─────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 },
  },
});

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
  if (err.message.includes("409")) {
    console.log("⚠️ Another instance detected. Restarting in 5s...");
    setTimeout(() => process.exit(1), 5000);
  }
});

// ─── Data Storage ─────────────────────────────────────────────────────────────
function loadData() {
  if (fs.existsSync(DATA_FILE)) return fs.readJsonSync(DATA_FILE);
  return { approved: [], pending: {}, tracks: {} };
}
function saveData(d) { fs.writeJsonSync(DATA_FILE, d, { spaces: 2 }); }
let db = loadData();
function persist() { saveData(db); }

// ─── Flipkart Scraper ─────────────────────────────────────────────────────────
async function scrapeFlipkart(url) {
  try {
    const cleanUrl = url.split("?")[0];
    const { data } = await axios.get(cleanUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept-Language": "en-IN,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      },
      timeout: 20000,
    });

    const $ = cheerio.load(data);

    // ── Product Name ──────────────────────────────────────────────────────
    let name = "";
    for (const sel of ["span.VU-ZEz", "span.B_NuCI", "h1.yhB1nd", "h1", "title"]) {
      const t = $(sel).first().text().trim();
      if (t && t.length > 3) { name = t.substring(0, 80); break; }
    }

    // ── Price ─────────────────────────────────────────────────────────────
    let price = null;

    $('script[type="application/ld+json"]').each((_, el) => {
      if (price) return;
      try {
        const json = JSON.parse($(el).html());
        const offers = json.offers || (json["@graph"] || []).find(x => x.offers)?.offers;
        if (offers) {
          const p = offers.price || offers.lowPrice;
          if (p) price = parseInt(String(p).replace(/[^0-9]/g, ""));
        }
      } catch (_) {}
    });

    if (!price) {
      const priceClasses = ["div.Nx9bqj.CxhGGd", "div.Nx9bqj", "div._30jeq3._16Jk6d", "div._30jeq3"];
      for (const sel of priceClasses) {
        const el = $(sel).first();
        if (el.length) {
          const raw = el.text().replace(/[₹,\s]/g, "");
          const m = raw.match(/(\d{3,7})/);
          if (m) { price = parseInt(m[1]); break; }
        }
      }
    }

    // ── Stock Status ──────────────────────────────────────────────────────
    let inStock = true;
    const bodyText = $("body").text().toLowerCase();
    for (const txt of ["currently unavailable", "out of stock", "notify me", "sold out"]) {
      if (bodyText.includes(txt)) { inStock = false; break; }
    }

    // ── Bank Offers (Fixed Selectors & Text-parsing fallback) ─────────────
    const offers = [];
    const seen = new Set();

    // Updated selectors for newer Flipkart markup
    $("li, div._3lK0oN, div.yBYrE2, span.Y1vEsn, li.XscZ69").each((_, el) => {
      const txt = $(el).text().replace(/\s+/g, " ").trim();
      if (
        /bank|hdfc|sbi|icici|axis|kotak|rbl|yes bank|cashback|discount|emi|instant|offer/i.test(txt) &&
        txt.length > 12 && txt.length < 250
      ) {
        // Cleaning extra words if any
        let cleanText = txt.replace(/T&C/g, "").trim();
        if (!seen.has(cleanText) && offers.length < 8) {
          seen.add(cleanText);
          offers.push(cleanText.substring(0, 180));
        }
      }
    });

    // Fallback: Agar selectors se ni mila toh raw regex content se offers find karega
    if (offers.length === 0) {
      const regexOffers = data.match(/(([1-9][0-9]%|Rs\.\s?\d+)\sInstant\sDiscount\son\s[a-zA-Z\s]+Bank)/gi);
      if (regexOffers) {
        regexOffers.forEach(off => {
          if (!seen.has(off) && offers.length < 5) {
            seen.add(off);
            offers.push(off);
          }
        });
      }
    }

    return { name, price, offers, inStock };
  } catch (err) {
    console.error("Scrape error:", err.message);
    return { name: null, price: null, offers: [], inStock: null };
  }
}

// ─── Keyboards ────────────────────────────────────────────────────────────────
const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "➕ Track New Product", callback_data: "add_track" }],
      [{ text: "📋 My Active Tracks",  callback_data: "list_tracks" }],
      [{ text: "🗑️ Remove a Track",    callback_data: "remove_menu" }],
    ],
  },
};

const adminMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "📥 Pending Requests", callback_data: "admin_pending" }],
      [{ text: "✅ Approved Users",   callback_data: "admin_approved" }],
      [{ text: "📱 Go to User Menu",  callback_data: "back_main" }], // Fixed: Admin users can also access tracking menu
    ],
  },
};

const waitingForUrl = new Set();

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const uid  = String(msg.from.id);
  const user = msg.from;

  // Strict String Comparison for Admin
  if (uid === ADMIN_ID) {
    if (!db.approved.includes(uid)) {
      db.approved.push(uid);
      persist();
    }
    return bot.sendMessage(ADMIN_ID, "👑 *Admin Panel*\n\nWelcome back, Boss! Aapke paas control access aur tracking features dono hain.",
      { parse_mode: "Markdown", ...adminMenu });
  }

  if (db.approved.includes(uid)) {
    return bot.sendMessage(uid,
      "✅ *Flipkart Price Alert Bot*\n\nAapka account approved hai! Kya track karna hai?",
      { parse_mode: "Markdown", ...mainMenu });
  }

  const name  = `${user.first_name || ""} ${user.last_name || ""}`.trim() || "Unknown";
  const uname = user.username ? `@${user.username}` : "N/A";
  db.pending[uid] = { name, username: uname };
  persist();

  bot.sendMessage(ADMIN_ID,
    `🔔 *New User Request*\n\n👤 Name: ${name}\n🔗 Username: ${uname}\n🆔 ID: \`${uid}\``,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[
        { text: "✅ Approve", callback_data: `approve_${uid}` },
        { text: "❌ Reject",  callback_data: `reject_${uid}` },
      ]]},
    }
  ).catch(console.error);

  bot.sendMessage(uid,
    "⏳ *Request Sent!*\n\nAdmin review karega. Approve hone ke baad bot use kar sakte ho.",
    { parse_mode: "Markdown" });
});

// ─── Callbacks ────────────────────────────────────────────────────────────────
bot.on("callback_query", async (q) => {
  const uid = String(q.from.id);
  const cb  = q.data;
  const cid = q.message.chat.id;
  const mid = q.message.message_id;
  bot.answerCallbackQuery(q.id).catch(() => {});

  if (cb.startsWith("approve_")) {
    if (uid !== ADMIN_ID) return;
    const target = cb.split("_")[1];
    if (!db.approved.includes(target)) db.approved.push(target);
    delete db.pending[target];
    persist();
    bot.editMessageText(`✅ User \`${target}\` approved!`,
      { chat_id: cid, message_id: mid, parse_mode: "Markdown" });
    bot.sendMessage(parseInt(target),
      "🎉 *Request Approved!*\n\nAb aap bot use kar sakte ho. /start karo!",
      { parse_mode: "Markdown", ...mainMenu }).catch(() => {});
    return;
  }

  if (cb.startsWith("reject_")) {
    if (uid !== ADMIN_ID) return;
    const target = cb.split("_")[1];
    delete db.pending[target];
    persist();
    bot.editMessageText(`❌ User \`${target}\` rejected.`,
      { chat_id: cid, message_id: mid, parse_mode: "Markdown" });
    bot.sendMessage(parseInt(target), "❌ Aapki request admin ne reject kar di.").catch(() => {});
    return;
  }

  if (cb === "admin_pending") {
    if (uid !== ADMIN_ID) return;
    if (!Object.keys(db.pending).length)
      return bot.editMessageText("📭 No pending requests.", { chat_id: cid, message_id: mid, ...adminMenu });
    let text = "📥 *Pending Requests:*\n\n";
    const btns = [];
    for (const [tid, info] of Object.entries(db.pending)) {
      text += `👤 ${info.name} (${info.username}) — \`${tid}\`\n`;
      btns.push([
        { text: `✅ ${info.name}`, callback_data: `approve_${tid}` },
        { text: "❌", callback_data: `reject_${tid}` },
      ]);
    }
    btns.push([{ text: "🔙 Back", callback_data: "admin_back" }]);
    return bot.editMessageText(text, {
      chat_id: cid, message_id: mid, parse_mode: "Markdown",
      reply_markup: { inline_keyboard: btns },
    });
  }

  if (cb === "admin_approved") {
    if (uid !== ADMIN_ID) return;
    const text = db.approved.length
      ? "✅ *Approved Users:*\n\n" + db.approved.map(u => `\`${u}\``).join("\n")
      : "📭 No approved users yet.";
    return bot.editMessageText(text, {
      chat_id: cid, message_id: mid, parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "admin_back" }]] },
    });
  }

  if (cb === "admin_back") {
    if (uid !== ADMIN_ID) return;
    return bot.editMessageText("👑 *Admin Panel*",
      { chat_id: cid, message_id: mid, parse_mode: "Markdown", ...adminMenu });
  }

  if (!db.approved.includes(uid) && uid !== ADMIN_ID)
    return bot.answerCallbackQuery(q.id, { text: "⛔ Access denied.", show_alert: true });

  if (cb === "add_track") {
    waitingForUrl.add(uid);
    return bot.editMessageText("🔗 *Product URL Bhejo*\n\nFlipkart product ka link paste karo:",
      { chat_id: cid, message_id: mid, parse_mode: "Markdown" });
  }

  if (cb === "list_tracks") {
    const ut = db.tracks[uid] || [];
    if (!ut.length)
      return bot.editMessageText("📭 Koi active track nahi hai.",
        { chat_id: cid, message_id: mid, ...mainMenu });
    let text = "📋 *Active Tracks:*\n\n";
    ut.forEach((t, i) => {
      const ps    = t.price ? `₹${t.price.toLocaleString("en-IN")}` : "N/A";
      const stock = t.inStock === false ? "❌ Out of Stock" : "✅ In Stock";
      text += `${i + 1}. *${t.name}*\n    💰 Price: ${ps} | ${stock}\n\n`;
    });
    return bot.editMessageText(text,
      { chat_id: cid, message_id: mid, parse_mode: "Markdown", ...mainMenu });
  }

  if (cb === "remove_menu") {
    const ut = db.tracks[uid] || [];
    if (!ut.length)
      return bot.editMessageText("📭 Koi track nahi hai.",
        { chat_id: cid, message_id: mid, ...mainMenu });
    const btns = ut.map((t, i) => [{
      text: `🗑️ ${t.name.substring(0, 40)}`,
      callback_data: `del_${i}`,
    }]);
    btns.push([{ text: "🔙 Back", callback_data: "back_main" }]);
    return bot.editMessageText("🗑️ *Kaun sa remove karein?*", {
      chat_id: cid, message_id: mid, parse_mode: "Markdown",
      reply_markup: { inline_keyboard: btns },
    });
  }

  if (cb.startsWith("del_")) {
    const idx = parseInt(cb.split("_")[1]);
    const ut  = db.tracks[uid] || [];
    if (idx >= 0 && idx < ut.length) {
      const [removed] = ut.splice(idx, 1);
      db.tracks[uid] = ut;
      persist();
      return bot.editMessageText(`✅ *${removed.name}* remove ho gaya!`,
        { chat_id: cid, message_id: mid, parse_mode: "Markdown", ...mainMenu });
    }
  }

  if (cb === "back_main") {
    const keyboard = (uid === ADMIN_ID) ? { reply_markup: { inline_keyboard: [...mainMenu.reply_markup.inline_keyboard, [{ text: "👑 Admin Panel", callback_data: "admin_back" }]] } } : mainMenu;
    return bot.editMessageText("✅ *Flipkart Price Alert Bot*\n\nKya track karna hai?",
      { chat_id: cid, message_id: mid, parse_mode: "Markdown", ...keyboard });
  }
});

// ─── Message Handler ──────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const uid  = String(msg.from.id);
  const text = msg.text.trim();

  if (!db.approved.includes(uid) && uid !== ADMIN_ID)
    return bot.sendMessage(uid, "⛔ Access denied. Admin approval pending.");

  if (waitingForUrl.has(uid)) {
    if (!text.includes("flipkart.com"))
      return bot.sendMessage(uid, "❌ Valid Flipkart URL bhejo bhai!");

    waitingForUrl.delete(uid);
    const loadMsg = await bot.sendMessage(uid, "⏳ Product aur Offers fetch ho rahe hain...");
    const { name, price, offers, inStock } = await scrapeFlipkart(text);

    if (!name)
      return bot.sendMessage(uid, "❌ Product fetch nahi ho paya. URL check karo ya thodi der baad try karo.");

    if (!db.tracks[uid]) db.tracks[uid] = [];
    db.tracks[uid].push({ url: text, name, price, offers, inStock });
    persist();

    const ps       = price ? `₹${price.toLocaleString("en-IN")}` : "N/A";
    const stockStr = inStock === false ? "❌ Out of Stock" : "✅ In Stock";
    const offerStr = offers.length
      ? offers.map(o => `• ${o}`).join("\n")
      : "⚠️ Koi Bank Offer parse nahi ho paya (Flipkart dynamic layout blocks directly scraping text).";

    const keyboard = (uid === ADMIN_ID) ? { reply_markup: { inline_keyboard: [...mainMenu.reply_markup.inline_keyboard, [{ text: "👑 Admin Panel", callback_data: "admin_back" }]] } } : mainMenu;

    return bot.sendMessage(
      uid,
      `✅ *Tracking Started!*\n\n📦 *${name}*\n💰 Current Price: *${ps}*\n📦 Stock: ${stockStr}\n\n🏦 *Bank Offers Found:*\n${offerStr}\n\n_Har 15 sec mein price change check hoga!_`,
      { parse_mode: "Markdown", ...keyboard }
    );
  }

  const keyboard = (uid === ADMIN_ID) ? { reply_markup: { inline_keyboard: [...mainMenu.reply_markup.inline_keyboard, [{ text: "👑 Admin Panel", callback_data: "admin_back" }]] } } : mainMenu;
  bot.sendMessage(uid, "👋 Menu ke liye buttons use karo ya /start refresh karo.", keyboard);
});

// ─── Background Checker ───────────────────────────────────────────────────────
async function checkPrices() {
  for (const [uid, userTracks] of Object.entries(db.tracks)) {
    for (const track of userTracks) {
      if (!track.url) continue;
      try {
        const { name, price: newPrice, offers: newOffers, inStock: newStock } =
          await scrapeFlipkart(track.url);
        if (!name) continue;

        const alertParts = [];
        const oldPrice   = track.price;
        const oldOffers  = track.offers || [];
        const oldStock   = track.inStock;

        if (newPrice && oldPrice && newPrice !== oldPrice) {
          const diff  = oldPrice - newPrice;
          const arrow = diff > 0 ? "📉" : "📈";
          const word  = diff > 0 ? "SASTA HO GAYA 🥳" : "MAHANGA HO GAYA 😬";
          alertParts.push(
            `${arrow} *Price ${word}!*\n` +
            `    Old: ₹${oldPrice.toLocaleString("en-IN")}\n` +
            `    New: ₹${newPrice.toLocaleString("en-IN")}\n` +
            `    Change: ₹${Math.abs(diff).toLocaleString("en-IN")}`
          );
          track.price = newPrice;
        }

        if (oldStock !== null && oldStock !== undefined && newStock !== oldStock) {
          alertParts.push(
            newStock
              ? "🟢 *STOCK WAPAS AA GAYA!* Ab order kar sakte ho! 🛒"
              : "🔴 *Out of Stock ho gaya!*"
          );
          track.inStock = newStock;
        }

        const addedOffers   = newOffers.filter(o => !oldOffers.includes(o));
        if (addedOffers.length) {
          alertParts.push("🆕 *Naye Bank Offers Paaye Gaye:*\n" + addedOffers.map(o => `• ${o}`).join("\n"));
          track.offers = newOffers;
        }

        if (alertParts.length) {
          persist();
          bot.sendMessage(parseInt(uid),
            `🚨 *ALERT — ${track.name}*\n\n` +
            alertParts.join("\n\n") +
            `\n\n[🔗 Product Link](${track.url})`,
            { parse_mode: "Markdown", disable_web_page_preview: true }
          ).catch(console.error);
        }
      } catch (err) {
        console.error(`Check error for ${uid}:`, err.message);
      }
    }
  }
}

setInterval(checkPrices, CHECK_INTERVAL);
console.log("🤖 Flipkart Price Alert Bot running flawlessly...");
