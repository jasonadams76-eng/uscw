# USCW – United States Championship Wrestling

A fictional pro-wrestling league game. Players sign up, create a wrestler (bio, move list, finisher), and the
CEO books **Monday Night Mayhem** and the monthly **Premium Live Events (PLEs)**: dates, venues, match cards,
promos and backstage segments. The CEO also awards the three championships (World Heavyweight, United States
Heavyweight, World Tag Team), shown at the top of the Superstars page and as badges on wrestler bios.

```
docs/     Static front-end (plain HTML/CSS/JS, no build step) -> GitHub Pages
worker/   Cloudflare Worker API + D1 (SQLite) schema         -> Cloudflare
```

Auth is built into the Worker (no third-party login service): email as username, 8–128 character passwords,
PBKDF2-SHA256 (100,000 iterations, per-user salt), lockout after 5 failed attempts (15 min), 30-day session tokens
(only a SHA-256 hash is stored), email confirmation, 1-hour password-reset links, and `users.is_admin` for the CEO.

## 1. Deploy the Worker

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create uscw          # copy the database_id it prints into wrangler.toml
npm run db:init:remote               # creates the tables from schema.sql (safe to re-run after updates)
```

Edit `worker/wrangler.toml`: set `SITE_URL`, `ALLOWED_ORIGINS` (your GitHub Pages origin, e.g.
`https://YOURNAME.github.io`, no path) and `SENDER_EMAIL` (the Gmail address you verify in Brevo). Then set the Brevo key (section 3) and:

```bash
npm run deploy                       # prints https://uscw-api.<subdomain>.workers.dev
```

## 2. Deploy the front-end (GitHub Pages)

1. Put your Worker URL in `docs/js/config.js` (`API_BASE`).
2. Create a GitHub repo and push this folder:
   ```bash
   git init && git add . && git commit -m "USCW" && git branch -M main
   git remote add origin https://github.com/YOURNAME/uscw.git && git push -u origin main
   ```
3. Repo **Settings → Pages → Build and deployment**: Deploy from a branch → `main` → folder `/docs`.
4. The site appears at `https://YOURNAME.github.io/uscw/`. Make sure `SITE_URL` and `ALLOWED_ORIGINS` in
   `wrangler.toml` match it, then redeploy the Worker.

## 3. Email through Brevo

A Worker can't speak SMTP, so it sends confirmation and password-reset emails through **Brevo's** HTTPS API
(free plan: 300 emails a day). USCW uses its **own** Brevo API key and sender address, separate from any other project.

**What you need to do in Brevo (about 10 minutes, one time):**

1. Create (or sign in to) your account at [brevo.com](https://www.brevo.com). A separate free account for USCW is the
   cleanest way to keep its 300-a-day allowance apart from your other games; one account with a second key also works,
   but the daily limit would then be shared.
2. **Add and verify the sender.** In Brevo go to **Senders, Domains & Dedicated IPs → Senders → Add a sender**.
   Name it `USCW` and enter the new USCW Gmail address. Brevo emails a verification code or link to that Gmail inbox;
   open it and confirm. Emails cannot be sent until this shows as verified.
3. **Create the API key.** Go to your account menu → **SMTP & API → API Keys → Generate a new API key**. Name it
   `uscw` and **copy the key right away**, because Brevo only shows it once.
4. **Check the IP restriction.** Under **Security → Authorised IPs** (the wording may vary), make sure IP blocking is
   **deactivated**. Cloudflare Workers don't send from a fixed IP address, so with blocking on, Brevo rejects every
   email with an "unrecognised IP" error.
5. **Give the key to the Worker** (paste it when prompted; it is never saved in your files):
   ```bash
   cd worker
   npx wrangler secret put BREVO_API_KEY
   ```
6. Make sure `SENDER_EMAIL` in `worker/wrangler.toml` is exactly the Gmail address you verified in step 2, then
   `npm run deploy`.

**Notes**
- If the first confirmation email doesn't arrive, check the spam folder. Mail sent from a free Gmail address through a
  service like Brevo is sometimes filtered; a sender on your own domain (verified in Brevo with its DNS records) avoids that.
- In Brevo, **Transactional → Logs** shows each email and why one failed.
- The Worker limits email to 3 per address per hour and 250 per day, so one person (or a bot) can't use sign-up or
  "forgot password" to flood an inbox or use up your allowance. When the daily limit is reached, new sign-ups pause
  until the next day.
- Without `BREVO_API_KEY` (local development) the Worker prints each email to the terminal instead of sending it.

## 4. Make yourself CEO

Sign up on the site and click the confirmation link, then:

```bash
cd worker
npx wrangler d1 execute uscw --remote --command "UPDATE users SET is_admin = 1 WHERE email = 'you@example.com'"
```

Refresh the site: a **CEO Office** link appears. Use the same command to promote anyone else.

## Local development

```bash
cd worker
npm install
npm run db:init:local
npm run dev                          # API on http://localhost:8787 (emails print in this terminal)

# in another terminal, serve the front-end on the origin the Worker allows:
npx serve docs -p 8080               # http://localhost:8080
```

`docs/js/config.js` defaults to `http://localhost:8787`. Remember to point it at the deployed Worker before pushing.

## API summary

| Route | Who | Purpose |
|---|---|---|
| `POST /api/register`, `/verify`, `/resend-verification` | anyone | sign up, confirm email |
| `POST /api/login`, `/logout`; `GET /api/me` | anyone / user | sessions |
| `POST /api/forgot`, `/reset` | anyone | password reset |
| `GET /api/wrestlers[/:id]` | anyone | roster and bios. A wrestler's real name and move set are only included for the CEO and that wrestler's own player; everyone else gets them blank |
| `PUT /api/wrestlers/:id` | owner or CEO | create/edit (player id = own user id). Every application field is required (400 with a message naming the first missing one), including at least one move in each of the five move categories |
| `DELETE /api/wrestlers/:id` | CEO | release a wrestler (any title they hold becomes vacant) |
| `GET /api/events[/:id]` | anyone (drafts: CEO only) | Monday Night Mayhem shows and PLEs (`ple: true`). Non-CEO callers receive only `match` segments; promos, backstage and other segments are CEO-only surprises. Each segment has a `length` in minutes (1–30) and a CEO-only `beats` script (text, pause, sound cue); the public sees only `length` and `scripted` |
| `PUT/DELETE /api/events/:id` | CEO | build and remove shows, including each segment's length and script beats |
| `POST /api/events/:id/watch` | anyone, once the show's start time has passed (CEO: any time) | a viewer presses Start; returns a `view` id. The CEO may send `speed` (1–20) to preview a show faster |
| `GET /api/events/:id/script?view=…&after=N` | the viewer who started it | the script beats whose time has come, with their segment headers. Nothing is ever sent ahead of the viewer's own clock |
| `GET /api/story`, `PUT /api/story/:id` | CEO only | each wrestler's recent results, feuds and show notes (stored in the `wrestler_story` table, created automatically). Never sent to anyone but the CEO |
| `POST /api/ai/draft` | CEO only | write a segment, polish the intro, via Gemini (see the AI writer section) |
| `GET/POST /api/submissions` | signed in | Superstar Hub: a player lists/creates their own pitches (max 3 pending); the CEO sees all |
| `PUT/DELETE /api/submissions/:id` | owner (pending only) / CEO | edit or withdraw; the CEO sets status and reply note |
| `POST /api/submissions/seen` | CEO only | clear the unseen badge |
| `GET /api/championships` | anyone | the three titles and their champions |
| `PUT /api/championships/:id` | CEO | award or vacate a title (`holders`, `since`, `wonAt`) |

## Notes

- Tokens live in the browser's `localStorage` and are sent as `Authorization: Bearer`, so there are no cookies to forge.
- Consider adding a Cloudflare rate-limiting rule on `/api/register` and `/api/forgot` to limit email spam.
- The PLE calendar lists the twelve monthly events (New Year's Ball, St. Valentine's Day Massacre, March Madness,
  Rage in the Cage, Memphis in May, Summer Spectacular, Beach Bash, Clash of the Titans, Annihilation, Halloween
  Horror, Rumble in the Jungle, Holiday Havoc). To book one, create an event and tick "This is a Premium Live
  Event"; it then shows on its month's row. The names live in `PLE_MONTHS` at the top of `docs/js/app.js`.
- Updating an existing deployment: run `npm run db:init:remote` once (adds the championships and email-limit tables), then
  `npm run deploy`.
- Possible next steps: match results and win/loss records, an archive of shows, rivalries.

## Live show text

Each segment can carry a script of beats (text, optional pause, optional sound cue). When a show's start time arrives, a
**Watch the show** button appears on its page. Each viewer starts their own run; the Worker releases the text at roughly
200 words a minute plus the CEO's pauses, so nobody can read ahead, and promos and backstage segments appear only at that
moment. The CEO can preview a show at ×4–×16 speed from the Start screen. The show's start time uses its time zone field
(ET, CT, MT, PT or a name like `America/Chicago`; blank means Eastern). Viewing records live in a small `show_views` table
that the Worker creates by itself and clears after 3 days.

## Show Intro and storylines

- A show can have one **Show Intro** segment. It is always the first segment, CEO-only, and opens with the show logo, the crowd pan, the `intro_music` cue and announcer Mike Johnson's welcome and card rundown.
- In the show editor, **Draft Intro** writes the beats from the card: matches with their stipulations and titles, wrestlers appearing in promos or other segments, and each wrestler's storyline. Review and edit, then save.
- Storylines live on each wrestler's profile (CEO only): recent results, current feuds and show notes. Write a show note so it continues the wrestler's name, for example "was attacked backstage by X". Upcoming matches are not entered by hand; they come from the published cards.
- Gemini (a later step) will receive the same data package and polish the text.

## AI writer (Gemini)

- Set the Worker **secret** `GEMINI_API_KEY` (Cloudflare dashboard, Settings, Variables and Secrets, type Secret). The key never reaches the browser.
- The CEO's **Draft with AI** (each segment), **Polish with AI** (Show Intro) and **Draft whole card with AI** buttons call `POST /api/ai/draft`.
- Two models: `gemini-3.8-flash` for the intro, non-match segments and the main event (about 20 free requests a day) and `gemini-3.5-flash-lite` for other matches (about 500 a day). The ids are constants at the top of the AI section in `worker/src/index.js`; set the variables `GEMINI_MODEL_MAIN` / `GEMINI_MODEL_LITE` to override without editing code. If the main model is out of quota or its name is wrong, the Worker retries with Flash-Lite.
- Announcers are fixed in the system instruction: Mike Johnson (serious play-by-play) and Earl Backwater (heel sympathizer). Only ring names, bios, moves, storylines and card details are sent to Google, never real names or accounts.
- A match's **Result** (winner and finish) is saved with the show but is CEO-only: it is stripped from the public event output.
- Draft whole card writes ticked segments in order with a 7-second pause between calls (free-tier rate limit).

## Superstar Hub
- Each player with a wrestler gets a private **My Hub** page to pitch segments (an idea, or exact text), up to 3 waiting at once.
- The CEO sees them under **CEO Office → Player Submissions**, with a red badge on the nav for unseen ones. Approve, decline, or reply with a note.
- In the show editor, approved pitches appear in a panel: **+ Add to card** turns text into script beats, or an idea into the segment's "What happens" brief for the AI. Saving the show marks the pitch "used".
- **✨ Polish with AI** (CEO only) appears on approved exact-text pitches, in the inbox (preview, then "Add to card" uses the polished text) and on the segment in the show editor. It keeps the player's content and results, and restyles it for the show. You see the original beside the polished text and choose **Use polished**, **Redraft** or **Keep original**.

## AI model fallbacks
Each AI call tries a chain of models and retries once (after 2 seconds) on a temporary Google error such as 503. Undercard matches: `GEMINI_MODEL_LITE`, then `GEMINI_MODEL_FALLBACK` (default `gemini-3.1-flash-lite`), then `GEMINI_MODEL_MAIN`. Everything else: `GEMINI_MODEL_MAIN`, then `GEMINI_MODEL_LITE`, then `GEMINI_MODEL_FALLBACK`. All three are optional Worker variables; the editor notes when a backup model wrote the text.

## Pin counts and near-falls
The AI writes each failed pin attempt as three beats: Mike calls the cover, a count beat, then the kickout. A count beat is text made only of numbers (`1 2` for a kickout, `1 2 3` for the finish, `1 2 3 4` for a rope break). The watch page shows it large and centered with one second between numbers, plays the crowd samples `count_1` to `count_3` if they exist, and on a kickout holds the 2 for a random 0.1 to 0.9 seconds before the kickout line. Matches are asked for a number of failed finish attempts based on their length, by both wrestlers, and a submission finisher is locked in at least once when its owner is set to lose. You can type count beats by hand in the editor too.

## Action beats
Spoken lines are written `Name: “...”`. A beat that describes action instead (the crowd, the camera, entrances, what happens in the ring) is wrapped in parentheses and shown in italics on the watch page. The AI writes it that way, the Worker wraps any action beat the AI forgot to, and the code-based intro writer follows the same rule. Saved scripts are not rewritten; redraft or Polish with AI to bring an older script into the style.

## Show cast
The AI writer knows the whole on-air cast: Mike Johnson (play-by-play) and Earl Backwater (color) commentate; Cindy Maxwell (ring announcer) introduces competitors and announces winners; Paul Sandler and Jackie O'Sullivan (interviewers) run promos and backstage segments; Jason Adams (Owner & CEO) appears in ceremonies and authority angles. The list lives in `AI_SYSTEM` in `worker/src/index.js`.

## Sound
Sound is fully optional. Put files in `docs/audio/` and list them in `docs/audio/sounds.json` (see `docs/audio/README.md`). A cue with no file stays silent, and with an empty manifest the watch page shows no sound controls. Show cues, per-wrestler entrance themes (by wrestler id) and a default entrance theme are supported. Viewers get a sound checkbox on the start screen plus a mute button and volume slider while watching. The show editor has a **▶ Test** button on each beat.

## Update notice

Every page load compares its version with `docs/version.json`; if a newer release is live, a banner offers a Reload button.
Run `node tools/stamp.js` before each commit that changes anything in `docs/` — it writes a fresh version and stamps the `?v=` cache-busters in `docs/index.html`.

## Wrestler portraits and entrance themes
- Portraits: put an image in `docs/img/wrestlers/` and add `"ring name lower case": "file.webp"` to `images.json`. Shown on Superstars tiles, champion cards and match headers.
- Entrance themes: `docs/audio/sounds.json` `entrances` maps a lower-case ring name (or wrestler id) to a ~30 s clip.

## Winner and promo themes
- When a match has a winner, that wrestler's theme plays at the winner announcement (the last beat that names a winner) and runs to the end of its clip. It stops early only when other music starts or the next segment begins.
- In promos, backstage segments and angles, an `entrance:<id>` cue also plays the theme through following beats. The AI prompt asks for these cues when a wrestler walks to the ring.

## Entrance themes in matches
An entrance theme loops under the announcers (dropping to 40% volume after a few seconds) until the next theme starts, the bell cue plays, or the segment changes. `docs/audio/bell.mp3` is the bell sound.
