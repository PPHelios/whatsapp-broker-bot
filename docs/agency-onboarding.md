# Adding and onboarding a new agency (POC)

Owner guide: how an agency is created, how its owner and managers get in on Telegram and the website, and what to check afterwards. Every step says whether it is **manual** (you do it by hand, or from a terminal with the database) or **automatic** (the app does it). Code references are for whoever checks this guide against the code; you do not need them to run the steps.

Related: `docs/runbook.md` §4 (onboarding file details), §7e (roles), §8 (common problems); `docs/pilot/telegram-howto-*.md` and `web-howto-*.md` (the guides to send brokers).

---

## Two ways an agency gets in

| | A. Hand onboarding (what the pilots used) | B. Self sign-up (switched on by you) |
| :--- | :--- | :--- |
| How it starts | You write a JSON file and run `npm run onboard` | The agency fills the form at `/app/signup` |
| Who creates it | You (terminal, with the database settings) | The agency; it waits until you approve it |
| Plan at start | Office, marked **pilot** (free until the POC ends) | Office **trial**, 14 days, after you approve |
| Owner's Telegram link | Printed in the terminal; you send it | Shown on `/app/owner` when you approve; you send it |
| Manual steps | Run the command, send links | Switch sign-up on, approve, send the link |

Use A for the pilots you pick. Use B only when you open sign-up to the public.

---

## A. Hand onboarding

### A1. Prepare the file — manual

1. Copy `docs/pilot/agency.example.json` and fill it in:
   - `agency.name`: the agency's name. Re-running the script matches the agency by this name.
   - `agency.slug` (optional): lower-case letters, digits and dashes. It becomes the public links. If another agency already has it, the run fails with `SLUG_TAKEN`.
   - `agency.code_prefix` (optional): 1 to 4 Latin letters for unit codes, e.g. `NH` gives `NH-V12`. Without it, the codes come from the name.
   - `agency.phone`, `logo_url` (`https://` only), `primary_color`, `secondary_color`, `flyer_theme`.
   - `telegram_bot`: `Wehdat_Hub_bot` (without the @). Without it the script prints no Telegram links.
   - `brokers`: one entry per person, each with `name`, `phone` (Egyptian mobile, e.g. `01000000001`), `role` and `lang` (`ar` or `en`).
2. Roles:
   - `owner`: the agency owner. Plan and payments, adding and removing managers, the secret-details switch, marking units private, deleting agency data.
   - `manager`: runs inventory, leads, imports and settings. Use `admin` only for old files; it works the same as `manager`.
   - `broker`: their own units and leads, plus the units they are allowed to see.
   - The file must have at least one `owner`, `admin` or `manager`. The first sign-up of an agency is always its owner; for a hand-onboarded agency, give the owner the role `owner` in the file.
3. A phone number can belong to one agency only. If it already belongs to another agency, the run stops with `PHONE_TAKEN`.

### A2. Dry run, then the real run — manual (terminal)

```
npm run onboard -- my-agency.json --dry-run
npm run onboard -- my-agency.json
```

- The dry run lists the people and prints the start links, writing nothing.
- The real run creates or updates the agency and brokers in one transaction (`scripts/onboard.js`, `lib/onboarding.js`). Re-running is safe: the agency matches by name and brokers by phone.
- It prints the agency id, slug, the web app address (`PUBLIC_BASE_URL`/app) and one **Telegram start link** per broker.
- Automatic: the agency is saved as `pilot = true` and `approval = approved`, so it is live at once on Office, free.
- WhatsApp is off by default (`WHATSAPP_ENABLED` must be `true` to turn it on). If `bot_phone` or `BOT_PHONE` is set, the script also prints WhatsApp start links; ignore them for the POC.

### A3. Send the links — manual

1. Send each person their Telegram start link **privately**. One tap, then *Start*, links their Telegram to their account.
   - Each link works once and lasts **7 days**.
   - An expired or used link: re-run `npm run onboard -- my-agency.json` for fresh ones, or ask a manager to tap *Team → send link* on the website (only for people not linked yet).
2. Send the guides in their language: `docs/pilot/telegram-howto-ar.md` (or `-en`) and `docs/pilot/web-howto-ar.md` (or `-en`).
3. Tell the agency owner how to sign in on the website (see B below).

### A4. Check the agency is ready — manual

On `/app/owner` (you must be a product owner, `OWNER_BROKER_IDS`):
- The agency appears in the agencies list with *Pilot* as its plan source and the brokers count is right.
- The **stuck list** shows no one yet. It lists active people who joined 2+ days ago and have no unit or lead, never linked Telegram, or went quiet for 7+ days. Expect entries until each person has tapped their link.

---

## B. Self sign-up (public)

### B1. Open sign-up — manual

1. Sign in as a product owner and go to `/app/owner`.
2. Turn on the **sign-up** switch (it is off by default). While it is on, `/app/signup` accepts requests and the landing page shows "Sign up your agency".
3. When you are done with a wave of sign-ups, turn it off again. Closed sign-up shows a "talk to us" page instead.

### B2. The agency fills the form — automatic

- Agency name, the admin's name, the admin's mobile, optional invite code from another agency, and the terms checkbox.
- The agency and its admin are saved with approval **pending** and the admin **inactive**, so nothing works yet. You are alerted.
- Duplicate phones are refused (`phone_taken`); a rate limit of 3 requests an hour per visitor applies.

### B3. Approve — manual, one click

1. On `/app/owner`, the **waiting sign-ups** list shows the request. Tap ✅ Approve (or ✖ Reject).
2. Approving does the following automatically: starts the **14-day Office trial**, activates the agency's brokers, and creates the admin's one-time Telegram start link (7 days).
3. The page shows a message with the link already written. **Copy it and send it to the admin privately.** The app does not send it for you.
   - If the page shows no link, the bot username is not set (`TELEGRAM_BOT_USERNAME`). Set it in Render, then take the admin's link from the Team page (it shows for people not yet linked).
4. The trial shows on `/app/owner` under *Agencies on a trial*. Its buttons extend it by a few days at a time.
5. Three days before the trial ends the agency gets a reminder (automatic). After it ends, the agency goes back to Free unless it pays.

### B4. Reject — manual

Tap ✖ Reject. The request is kept as rejected; nothing is activated.

---

## C. The agency owner and managers get in

### C1. Telegram (main path)

1. The person taps their start link, presses *Start*, and the bot links them. A broker with a link never has to type a phone number.
2. If the link expired, they open the bot and tap *📱 Share my number*. This works only for the number the agency registered, and only when they share their own contact.
3. They can send *help* in the bot at any time for the guide.

### C2. Website

1. From the bot, the **WehdatHub** button next to the message box opens the website already signed in (Mini App, `/app/tg`).
2. On another device, the person goes to `/app/login`, enters their registered mobile, and a sign-in link arrives on Telegram within about a minute. Or they send *login* to the bot.
3. There are no passwords. Sessions end when the person signs out or is deactivated.

### C3. Adding the agency's managers and brokers — automatic after the owner does it

The agency owner (or a manager, for brokers) does this on the website, **Team** page:
1. *Invite*: name, mobile, role (`broker`, or `manager` for the owner only). The app returns a one-time Telegram link; the owner sends it.
2. Seats: each plan has a seat limit. A new or returning person needs a free seat, otherwise the invite says so. Plan limits are on `/app/plan`.
3. A mobile already used by another agency is refused.
4. Deactivating someone moves their leads to the unassigned pool and tells managers. From the Team page, or from the terminal with `npm run onboard -- --deactivate my-agency.json <phone>`.

### C4. Owner-only actions

Only the agency owner can change a manager's role (`/team/:id/role`) and set a broker's secret-details switch. Managers cannot touch owner rows.

---

## D. Your plan and payment settings — manual

- **Pilot agencies**: nothing to do; Office is free until the POC ends. The *pilot* checkbox on the agency's page keeps them on Office.
- **Paid or trial agencies**: on `/app/owner`, open the agency and set the plan, plus either an end date or months. Saving with the pilot box ticked keeps it free regardless of the plan.
- **Payments**: the agency pays through InstaPay (the owner's account, editable on `/app/owner`). A payment appears under *pending payments*; tap ✅ Received when the money arrives. Referral months are applied automatically on first payment.
- **Suspend or resume** an agency from its page; a suspended agency is locked out.

---

## E. After onboarding: what to check

Do these within the first day:

| Check | Where | Good looks like |
| :--- | :--- | :--- |
| Owner linked on Telegram | `/app/owner` agency row, or the Team page | Brokers show as linked, not "link pending" |
| Owner can sign in on the website | Ask them to open the website from the bot | The website opens signed in |
| First unit added | Owner's units | At least one unit from a broker within a day |
| First lead or search | Leads / search | Someone searches or adds a lead |
| Stuck list | `/app/owner` | Shrinks as people tap their links |
| Trial or pilot status | `/app/owner` | Pilot or the trial end date is right |
| Errors | `/app/owner` and `error_events` (runbook §6b) | No new errors for this agency |

Day 1, 3 and 7 nudges go to each new broker automatically (Telegram or the website only). Follow up by hand with anyone still on the stuck list after 3 days.

---

## F. Common problems

| Symptom | Fix |
| :--- | :--- |
| Run stops with `SLUG_TAKEN` | Pick another `slug` in the file. |
| Run stops with `PHONE_TAKEN` | The phone is registered with another agency. Use a different number, or the other agency must release it. |
| No Telegram links printed | Set `telegram_bot` in the file, or `TELEGRAM_BOT_USERNAME` in Render. |
| A start link says invalid or expired | Links are one use and last 7 days. Re-run the onboard command or send a fresh one from the Team page. |
| Approve page shows no link | `TELEGRAM_BOT_USERNAME` is not set. Set it in Render, then take the admin's link from the Team page. |
| The owner cannot sign in on the website | Their number must be registered and their Telegram linked. Ask them to send *login* to the bot. |
| The agency says the seats are full | Raise the plan or deactivate someone who left (their seat frees up). |

---

## Open gaps (for Haytham to decide; no code changed here)

1. **No owner-page button to create an agency by hand.** Option A needs the terminal. The owner page only approves public sign-ups.
2. **Approve does not send the admin's link.** You copy it from the page and send it yourself.
3. **Approving needs `TELEGRAM_BOT_USERNAME` set**, or no start link is shown.
4. **Hand onboarding always sets `pilot = true`.** A paying agency started this way needs its plan changed on `/app/owner`, with the pilot box cleared.
