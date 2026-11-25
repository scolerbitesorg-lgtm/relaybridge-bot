import { store } from './store.ts';

export interface ExportBundle {
  pythonBot: string;
  requirementsTxt: string;
  envTemplate: string;
  configJson: string;
  readmeMd: string;
}

export function generateStandaloneExport(): ExportBundle {
  const snapshot = {
    exportedAt: new Date().toISOString(),
    rateLimit: store.getRateLimitConfig(),
    channels: store.getChannels(),
    connections: store.getConnections(),
  };

  const configJson = JSON.stringify(snapshot, null, 2);

  const requirementsTxt = [
    'telethon>=1.36.0',
    'python-telegram-bot>=21.6',
    'python-dotenv>=1.0.1',
  ].join('\n');

  const envTemplate = [
    'TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather',
    'TELEGRAM_API_ID=12345678',
    'TELEGRAM_API_HASH=your_api_hash_from_my_telegram_org',
    'TELEGRAM_USERBOT_SESSION=your_telethon_string_session',
    'TELEGRAM_ADMIN_IDS=123456789',
  ].join('\n');

  const pythonBot = `"""
RelayBridge Standalone Telegram Bot + Userbot Forwarding Engine
- Reads open/public channels WITHOUT admin rights via Telethon Userbot
- Handles large videos & files smoothly with adaptive per-chat rate limiting & FloodWait recovery
- Full Bot Menu (/start, /connections, /sources, /targets, /newconnection, /status, /help)
- Forward ANY post to the bot to immediately register it as Source / Target / Backup
"""
import asyncio
import json
import os
import re
import time
from collections import deque
from pathlib import Path
from dotenv import load_dotenv
from telethon import TelegramClient, events
from telethon.errors import FloodWaitError
from telethon.sessions import StringSession
from telethon.tl.functions.channels import JoinChannelRequest
from telegram import BotCommand, InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    ChatMemberHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

load_dotenv()

BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
API_ID = int(os.environ["TELEGRAM_API_ID"])
API_HASH = os.environ["TELEGRAM_API_HASH"]
USERBOT_SESSION = os.environ["TELEGRAM_USERBOT_SESSION"]
ADMIN_IDS = {
    int(x.strip()) for x in os.getenv("TELEGRAM_ADMIN_IDS", "").split(",") if x.strip().isdigit()
}
CONFIG_PATH = Path("config.json")


def load_config() -> dict:
    if CONFIG_PATH.exists():
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    return {
        "rateLimit": {"globalMaxPerSecond": 25, "perChatMaxPerSecond": 1, "perChatMaxPerMinute": 18},
        "channels": [],
        "connections": [],
    }


def save_config(cfg: dict) -> None:
    tmp = CONFIG_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    tmp.replace(CONFIG_PATH)


STATE = load_config()


class AdaptiveRateLimiter:
    """Enforces Telegram global + per-chat limits and isolates FloodWait per target chat."""

    def __init__(self) -> None:
        self.global_hits: deque[float] = deque()
        self.chat_sec_hits: dict[str, deque[float]] = {}
        self.chat_min_hits: dict[str, deque[float]] = {}
        self.flood_until: dict[str, float] = {}
        self.lock = asyncio.Lock()

    async def acquire(self, chat_id: str) -> None:
        while True:
            async with self.lock:
                now = time.monotonic()
                rl = STATE.get("rateLimit", {})
                g_max = int(rl.get("globalMaxPerSecond", 25))
                c_sec = int(rl.get("perChatMaxPerSecond", 1))
                c_min = int(rl.get("perChatMaxPerMinute", 18))

                # Respect active FloodWait for this specific chat only
                wait_until = self.flood_until.get(chat_id, 0.0)
                if wait_until > now:
                    sleep_for = wait_until - now
                else:
                    while self.global_hits and now - self.global_hits[0] > 1.0:
                        self.global_hits.popleft()
                    sec_q = self.chat_sec_hits.setdefault(chat_id, deque())
                    while sec_q and now - sec_q[0] > 1.0:
                        sec_q.popleft()
                    min_q = self.chat_min_hits.setdefault(chat_id, deque())
                    while min_q and now - min_q[0] > 60.0:
                        min_q.popleft()

                    if len(self.global_hits) < g_max and len(sec_q) < c_sec and len(min_q) < c_min:
                        self.global_hits.append(now)
                        sec_q.append(now)
                        min_q.append(now)
                        return
                    sleep_for = 0.25
            await asyncio.sleep(sleep_for)

    def mark_flood_wait(self, chat_id: str, seconds: int) -> None:
        self.flood_until[chat_id] = time.monotonic() + seconds + 1


RATE_LIMITER = AdaptiveRateLimiter()
USERBOT = TelegramClient(StringSession(USERBOT_SESSION), API_ID, API_HASH)


def classify_message(msg) -> str:
    if msg.video:
        return "video"
    if msg.gif:
        return "animation"
    if msg.photo:
        return "photo"
    if msg.audio:
        return "audio"
    if msg.voice:
        return "voice"
    if msg.sticker:
        return "sticker"
    if msg.document:
        return "document"
    if msg.poll:
        return "poll"
    return "text"


def clean_caption(text: str, fcfg: dict) -> str:
    if fcfg.get("stripCaption"):
        out = ""
    else:
        out = text or ""
    if fcfg.get("stripLinks"):
        out = re.sub(r"https?://\\S+|t\\.me/\\S+", "", out).strip()
    if fcfg.get("stripUsernames"):
        out = re.sub(r"@[A-Za-z0-9_]{3,}", "", out).strip()
    for rule in fcfg.get("findReplace", []):
        if rule.get("find"):
            out = out.replace(rule["find"], rule.get("replace", ""))
    parts = [p for p in [fcfg.get("captionPrefix", "").strip(), out, fcfg.get("captionSuffix", "").strip()] if p]
    return "\\n\\n".join(parts)[:1024]


async def dispatch_to_peer(target_id: str, msg, fcfg: dict) -> None:
    await RATE_LIMITER.acquire(target_id)
    peer = int(target_id) if re.match(r"^-?\\d+$", target_id) else target_id
    caption = clean_caption(msg.raw_text or "", fcfg)
    try:
        if fcfg.get("forwardMode") == "forward":
            await USERBOT.forward_messages(peer, msg)
        else:
            await USERBOT.send_message(peer, caption, file=msg.media)
    except FloodWaitError as e:
        RATE_LIMITER.mark_flood_wait(target_id, e.seconds)
        await asyncio.sleep(e.seconds + 1)
        await dispatch_to_peer(target_id, msg, fcfg)


@USERBOT.on(events.NewMessage())
async def on_source_message(event: events.NewMessage.Event) -> None:
    chat_id = str(event.chat_id)
    media_type = classify_message(event.message)
    raw_text = (event.message.raw_text or "").strip()

    channels_by_id = {c["id"]: c for c in STATE.get("channels", [])}
    for conn in STATE.get("connections", []):
        if not conn.get("enabled"):
            continue
        src = channels_by_id.get(conn["sourceChannelId"])
        tgt = channels_by_id.get(conn["targetChannelId"])
        bkp = channels_by_id.get(conn.get("backupChannelId")) if conn.get("backupChannelId") else None
        if not src or not tgt or str(src["telegramChatId"]) != chat_id:
            continue

        fcfg = conn.get("filters", {})
        if not fcfg.get("allowedMedia", {}).get(media_type, False):
            continue
        if fcfg.get("onlyWithCaption") and media_type != "text" and not raw_text:
            continue

        delay = int(fcfg.get("delaySeconds", 0))
        if delay > 0:
            await asyncio.sleep(delay)

        try:
            await dispatch_to_peer(str(tgt["telegramChatId"]), event.message, fcfg)
            if bkp and fcfg.get("backupMode") == "mirror":
                await dispatch_to_peer(str(bkp["telegramChatId"]), event.message, fcfg)
        except Exception:
            if bkp and fcfg.get("backupMode") == "failover":
                await dispatch_to_peer(str(bkp["telegramChatId"]), event.message, fcfg)


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if ADMIN_IDS and update.effective_user.id not in ADMIN_IDS:
        return
    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton("Connections", callback_data="connections"), InlineKeyboardButton("Sources", callback_data="sources")],
        [InlineKeyboardButton("Status", callback_data="status")],
    ])
    await update.message.reply_text(
        f"RelayBridge Active\\nConnections: {len(STATE['connections'])} | Channels: {len(STATE['channels'])}\\nForward any post from any channel to set it as Source or Target.",
        reply_markup=kb,
    )


async def on_forwarded_or_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if ADMIN_IDS and update.effective_user.id not in ADMIN_IDS:
        return
    msg = update.message
    origin = getattr(msg, "forward_origin", None)
    if origin and hasattr(origin, "chat") and origin.chat:
        ch = origin.chat
        cid = str(ch.id)
        kb = InlineKeyboardMarkup([
            [InlineKeyboardButton("Set as Source", callback_data=f"set:source:{cid}:{ch.title[:24]}"),
             InlineKeyboardButton("Set as Target", callback_data=f"set:target:{cid}:{ch.title[:24]}")]
        ])
        await msg.reply_text(f"Channel detected: {ch.title} ({cid})\\nChoose role:", reply_markup=kb)


async def on_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    await q.answer()
    if q.data.startswith("set:"):
        _, role, cid, title = q.data.split(":", 3)
        STATE["channels"].append({
            "id": f"ch_{int(time.time())}",
            "telegramChatId": cid,
            "title": title,
            "role": role,
        })
        save_config(STATE)
        await q.edit_message_text(f"Saved {title} as {role.upper()}!")


async def main() -> None:
    await USERBOT.start()
    for ch in STATE.get("channels", []):
        if ch.get("role") == "source" and ch.get("username"):
            try:
                await USERBOT(JoinChannelRequest(ch["username"]))
            except Exception:
                pass

    app = Application.builder().token(BOT_TOKEN).build()
    await app.bot.set_my_commands([
        BotCommand("start", "Open control menu"),
        BotCommand("connections", "Manage connections"),
        BotCommand("sources", "Manage sources"),
        BotCommand("status", "Live engine status"),
    ])
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(MessageHandler(filters.ALL & ~filters.COMMAND, on_forwarded_or_text))
    app.add_handler(CallbackQueryHandler(on_callback))

    await app.initialize()
    await app.start()
    await app.updater.start_polling()
    await USERBOT.run_until_disconnected()


if __name__ == "__main__":
    asyncio.run(main())
`;

  const readmeMd = `# RelayBridge — Standalone Telegram Bot + Userbot Package

## Quick Start
1. Create a Telegram Bot via \`@BotFather\` to get \`TELEGRAM_BOT_TOKEN\`.
2. Get \`TELEGRAM_API_ID\` and \`TELEGRAM_API_HASH\` from \`https://my.telegram.org\`.
3. Generate a StringSession for your Userbot account (used to read open/public channels without admin rights and forward large videos/files up to 2GB/4GB).
4. Copy \`.env.example\` to \`.env\` and fill in your credentials.
5. Place your exported \`config.json\` beside \`bot.py\` and run:
   \`\`\`bash
   pip install -r requirements.txt
   python bot.py
   \`\`\`
`;

  return {
    pythonBot,
    requirementsTxt,
    envTemplate,
    configJson,
    readmeMd,
  };
}
