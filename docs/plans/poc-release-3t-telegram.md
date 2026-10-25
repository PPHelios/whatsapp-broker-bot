# POC Release 3T — Telegram + website (build plan)

**Decision (Haytham, 2026-10-25):** for the POC, brokers use the bot on **Telegram**. The website opens inside Telegram as a **Mini App**. WhatsApp is kept only for clients: `wa.me` links, brochures, and an optional paid alerts add-on (449 EGP per 1,000 messages). Telegram bot messages cost nothing, so the cost per agency is just AI, capped by each plan.

**When:** right after Release 3. Release 3 is already merged and live, so this is a new release on `main`, built before the pilot starts. **Estimate:** 6–8 working days.

## What I need from Haytham

1. **Create the bot in @BotFather** (`/newbot`):
   - name "WehdatHub" (or the final brand)
   - a username ending in `bot`
   - photo, about text and description in Arabic
2. **Put the token in Render** yourself, as `TELEGRAM_BOT_TOKEN`. Don't paste it in chat. I set `TELEGRAM_WEBHOOK_SECRET` and run `setWebhook`.
3. **Mini App:** in @BotFather run `/mybots` → the bot → *Bot Settings* → *Configure Mini App* → *Enable*, with URL `https://whatsapp-broker-bot.onrender.com/app/`. Also set the *Menu Button* to the same URL. I'll send the exact steps when the code is ready.
4. **Confirm the pilot brokers will use Telegram.** This is the biggest adoption risk: every broker installs it and keeps it open.
5. **Answer one question:** should the WhatsApp bot stay usable during the pilot as a fallback? My recommendation is **yes**. Brokers already linked keep working there, and its replies still use credits.

## Steps

1. **Telegram adapter (inbound):**
   - `POST /telegram/webhook`, checking the `X-Telegram-Bot-Api-Secret-Token` header (fail-closed).
   - Each update becomes the same message shape as WhatsApp and goes into `handleInboundMessage`, with `update_id` as the dedupe key in `inbound_messages`. Render Free cold starts make Telegram retry, so the dedupe matters.
   - Handled: text, voice/audio (OGG/Opus via `getFile`, same Gemini path), photos (largest size), documents (`.xlsx`, chat-export `.zip`), contacts, forwarded messages, and `callback_query` (button taps), each acknowledged with `answerCallbackQuery`.
2. **Account linking:**
   - `onboard` prints a `t.me/<bot>?start=<token>` link per broker. The token is one-time, hashed, and lasts 7 days, like the sign-in tokens.
   - `/start <token>` links the Telegram user to the broker record.
   - Without a token, a "📱 Share my number" button (`request_contact`) matches the broker by phone. Only the user's own contact counts (`contact.user_id` must equal `from.id`).
   - New columns `brokers.telegram_user_id` and `telegram_chat_id`, plus migration 019. One broker, one account, across Telegram, the web and WhatsApp.
3. **Replies on the right channel:**
   - `dispatcher.reply`, `replyButtons`, `replyList`, `replyImage` and `replyDocument` send to the channel the turn came from.
   - `lib/channels/telegram.js` gets real `send` methods (text, inline keyboards, photo and document uploads).
   - WhatsApp `*bold*`/`_italic_` are converted to Telegram HTML, with escaping.
   - Lists become inline-keyboard rows.
   - **Telegram limits `callback_data` to 64 bytes.** Longer button ids (e.g. Undo sets) are stored server-side under a short token.
4. **Credits and windows:**
   - A Telegram reply is not a WhatsApp message: no credits, no 24-hour window, no ceiling notices.
   - The usage page shows WhatsApp only for the add-on.
5. **Notifications:**
   - Channel per alert: Telegram (default, free), website push, or WhatsApp (add-on credits only).
   - Quiet hours, merging and dedupe stay as they are.
   - Reminder and alert buttons (Done, Postpone, Follow-up) work in Telegram.
6. **Getting things to clients:**
   - Every message meant for a client (client copy, unit link, send-to-client) gets a **"📤 Send on WhatsApp"** button: `wa.me/?text=<encoded>`, or `wa.me/<client>?text=` when the client is known. This avoids the timestamps Telegram adds when several messages are copied at once.
   - Flyers and photos: a share page `/app/units/<code>/share-media` uses `navigator.share` with the image files, so one tap opens WhatsApp with the pictures.
7. **Mini App and web sign-in:**
   - `/app/` inside Telegram signs in automatically. `Telegram.WebApp.initData` is checked server-side (HMAC with the bot token, `auth_date` under 1 hour) and then creates the normal session.
   - CSP `frame-ancestors` allows `https://web.telegram.org` (Telegram Web shows Mini Apps in an iframe).
   - Session cookies there need `SameSite=None; Secure`, or a short-lived token in the URL. I'll test both and pick one.
   - The `«دخول»` link still works from the bot.
8. **Config, docs, tests:**
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`.
   - Runbook: webhook setup and rotation.
   - Telegram guides in Arabic and English replace the WhatsApp ones for brokers. Copy changes: "message the bot first", credits.
   - A fake Telegram harness like `fake-whatsapp`, so the router tests run on both channels.

## What changes or breaks for brokers

- **Forwarding from WhatsApp:** you can't forward a WhatsApp message straight to a Telegram bot. Brokers share it (long-press → Share → Telegram) or copy the text. A shared WhatsApp contact arrives as a contact or a `.vcf`; both are handled. Voice notes shared from WhatsApp arrive as audio files and work.
- **Client copies, flyers and photos** no longer sit in the same app as the client. They take one extra tap through the Send-on-WhatsApp button or the share page.
- **Two apps:** brokers live in Telegram for the bot and in WhatsApp for clients.
- **Unchanged:** everything on the website, the data, unit codes, search, the CRM, deals, and the public unit pages and their links.
- **WhatsApp bot (if kept as a fallback):** works as today. Its replies still use credits.
- **Privacy:** client names and numbers in bot messages go through Telegram instead of WhatsApp. The privacy note and the guides say so.
- **Render Free:** a cold start delays the first reply by up to about a minute. Telegram retries the webhook; the `update_id` dedupe stops doubles.

## Not in this release

Telegram groups (bot added to an agency group), Telegram Stars or payments, and moving clients to Telegram.
