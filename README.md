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
- Entrance themes: `docs/audio/sounds.json` `entrances` maps a lower-case ring name (or wrestler id) to a ~60 s clip. Current themes: Hardbody Harrison, Paco Rodriguez and Sweardog McKraken (the first 60 s of his song, no fade-in, 3 s fade-out; `entrance-sweardog.mp3`).

## Winner and promo themes
- When a match has a winner, that wrestler's theme plays at the winner announcement (the last beat that names a winner) and runs to the end of its clip. It stops early only when other music starts or the next segment begins.
- In promos, backstage segments and angles, an `entrance:<id>` cue also plays the theme through following beats. The AI prompt asks for these cues when a wrestler walks to the ring.

## Entrance themes in matches
An entrance theme plays once through (no looping, at a steady 40% of the viewer’s volume from the start) unless the next theme starts, the bell cue plays, or the segment changes first. In promos, interviews and other non-match segments it also fades out over 1.5 s as soon as a wrestler starts talking (a line that begins with a wrestler's ring name and a colon; Mike, Earl and Cindy don't count). `docs/audio/bell.mp3` is the bell sound.

## Intro rundown, main-event hype and mirrored feuds
- The show intro gives every match 2 to 3 sentences on why to care (Mike plus Earl). The AI draws only on facts on file; the built-in writer uses feuds, recent results, the title and the stipulation.
- The main event match (the last match when the card has two or more) opens with one Mike Johnson hype beat before the entrances.
- Feuds are mirrored: adding, editing or removing a feud on one wrestler does the same on the other. Opening Storylines once also copies any older one-sided feud onto the other wrestler. Changes save instantly (no save button).

## Superstar Level (CEO only)
Each wrestler's Storylines panel has a Superstar Level: Not set, Jobber, Lower Card, Mid Card or Superstar. It is private (storylines are CEO-only) and saves instantly. The AI receives only an "announcer attitude" description, never the label, so the announcers show it through opinions and react with surprise to upsets and to titles held above someone's standing. Drafts are scanned for insider terms (jobber, lower card, mid card, upper card, "doing the job", and so on); a draft containing one is rewritten once and rejected with a message if it still does.

## Recorded results and head-to-head
- When a published show's release time has passed, every match with a winner (or a draw) is recorded in the `match_results` table, one row per wrestler, never trimmed. The Worker catches up whenever Storylines is opened or an AI draft is requested.
- A wrestler's Recent results panel shows the 5 most recent; the CEO can Edit or delete an automatic result (an edited or deleted result is not overwritten by later catch-ups). The old Add result form is gone; hand-entered results already on file stay until deleted.
- The AI gets "PREVIOUS MEETINGS" (up to 5, newest first) for each match and in the intro rundown, plus each wrestler's last 5 results as recent form. The built-in intro writer mentions how often the two have met and who won last.

## Player portraits
- On their own wrestler's page a player picks an image, frames it in a crop box (480 x 847 WebP, about 40-150 KB) and submits it. It stays private (pending) until the CEO approves it in the CEO Office, where a Portrait Submissions group appears with a badge like other submissions.
- Approved portraits are stored in the D1 `portraits` table and served from `/api/portrait/<id>`; they replace file-based portraits (`docs/img/wrestlers`). Only the CEO can remove an approved portrait, and a CEO upload applies immediately. Players can submit 5 a day; the Worker checks the real file type and size.

## Appearance, AI image and wrestler applications
- The wrestler form has an **Appearance** section: gender, physical appearance and ring gear (all required for a new application; existing wrestlers can still save edits without them). They are shown on the wrestler page and given to the AI writer, so the announcers can mention gear naturally and now and then (they are told never to invent gear).
- **Request Contract** (was "Sign Contract") sends a new application. It stays **pending** until the CEO approves it under *Wrestler Applications* in the CEO Office (nav badge counts them). Pending or declined wrestlers are not on the roster, cannot use the Hub, and are visible only to the owner and the CEO. A declined application, once revised, goes back to pending. NPCs the CEO adds are approved immediately; wrestlers that already existed are unaffected.
- **Generate Wrestler Image** (form and Portrait panel) calls `POST /api/portrait-generate`, which calls Gemini with only appearance, gear, gender, height and weight (never names, age, hometown or email). The player can only "Use this image" or "Don't use"; there is no retry. A used image goes through the normal portrait approval. One successful image per player per 24 hours (the CEO is exempt; failed or blocked results do not count).
- Prompt text: the `IMAGE_PROMPT` constant in `worker/src/index.js`. Model: Worker variable `GEMINI_MODEL_IMAGE` (default `gemini-3.1-flash-image`; confirm the name in AI Studio). Uses the same `GEMINI_API_KEY` secret.

## Pyro
`docs/audio/pyro.mp3` is the `pyro` cue (listed in the CEO sound dropdown and allowed for the AI writer). It plays on top of any theme music, which keeps going. Any beat whose text mentions pyro, pyrotechnics or fireworks plays it automatically timed so the first blast (0.25 s into the clip) lands exactly as the word finishes appearing, not at the start of the line, and a `pyro` cue put on the line before is moved to the next action line `( … )` that mentions it. A pyro cue on a line that never mentions it still plays at the start of the line. The AI only has to write the mention.

After a count that stops at 2, one to four dots (random each time) appear one at a time after the 2 while the pin hangs, then the kickout line follows.

## Ambient crowd
`docs/audio/crowd.mp3` (listed as `ambient` in `sounds.json`) loops quietly for the whole show: it starts when the viewer starts or resumes, runs at 25% of their volume (`AMBIENT_LEVEL` in `app.js`), follows the volume slider and the mute button, and fades out over 4 seconds when the show ends. It is its own audio channel, so themes, the bell and pyro play over it without touching it.

## Crowd boos
`docs/audio/boos.mp3` is the `crowd_boo` cue. It plays on top of everything else (themes and the ambient crowd keep going), and any beat whose text mentions boos, booing or jeers plays it automatically. The boos start as the line reaches the word (about 0.2 s early), not at the start of the line, and a `crowd_boo` cue put on the line before is moved to the next action line `( … )` that mentions boos. Pyro still plays at the start of its line. The AI writer is told to write the mention and not add the cue itself.

## Show theme
The `intro_music` cue plays once through to the end of the file at a steady 40% of the viewer's volume (no fade-down). Plain beats and new segments do not cut it; it stops early only when another theme (an entrance or winner theme) or the bell comes in, which fade it out over 2.5 s and 1.5 s.

## Slam on the mat
`docs/audio/slam.mp3` is the `mat_slam` cue. It plays once on top of everything else; the AI writer may pick the cue, and there is no automatic word trigger. The sound is held until the end of its line and started 0.78 s before the last words appear, so the hit in the clip lands as the line finishes (a slam cue on an empty beat plays at once).

## Crowd pops and chair shot
`docs/audio/pop-small.mp3` is `crowd_pop` ("Crowd pop (small)"), `pop-big.mp3` is the new `crowd_pop_big` ("Crowd pop (big)", for major moments only; the AI writer is told to use it rarely) and `chair.mp3` is `chair_shot`. Each plays once on top of everything else. There is no automatic word trigger for these three; the AI writer or the CEO picks the cue.

## Pin count sounds
`count-1.mp3`, `count-2.mp3` and `count-3.mp3` (`count_1` to `count_3`) were cut from one pinfall recording at the mat slaps, each starting about 60 ms before its slap, so a number's sound lands the moment that number appears on screen (the page plays it in the same instant it adds the number). A kickout plays 1 and 2; a pin plays all three, and the third carries the crowd celebration.

A count that includes a 4 (a rope-break count, `1 2 3 4`) is not a pin attempt: it shows as a plain italic line ("The referee counts… 1 … 2 … 3 … 4"), one number per second, with no big numbers, no dots and no count sounds. Only 1 2 and 1 2 3 counts get the big-number display and the crowd sounds.

The slam clip was boosted by 14 dB (with a limiter) because it was much quieter than the other effects. The clip is 4 s long: the original 2.2 s hit with a crowd-reaction tail added (a few seconds of the ambient stadium crowd blended in under the end) that swells, holds for a moment and then fades to silence, so the impact no longer cuts off. The hit is still 0.78 s in, so the timing note above is unchanged.

The ambient clip is 3 minutes taken from 27:30 of a one-hour stadium crowd recording. Its last 2 seconds are blended into the first 2 so the loop restart is inaudible.

## Bell timing
The bell sound plays on the beat whose text says the bell rings. If the AI puts the bell cue on the referee/build-up line just before it, the Worker moves it to the next line that mentions the bell, and the live player does the same for scripts that were already saved.

## No title, no championship talk
When a match has no title/billing in its details, the AI prompt says so explicitly (and the general rules repeat it): the writer must not call it a title match or mention championship implications, a title shot or a belt. A wrestler's own reigning title can still come up as background. The fix is in the Worker prompt only, so it applies to matches generated after the Worker is redeployed.

## Crowd pop timing
A `crowd_pop` / `crowd_pop_big` cue on a beat whose text talks about the crowd roaring (roar, erupts, cheers, ovation, goes wild and similar) starts as the line reaches that word, about 0.3 s before it is fully on screen, instead of at the start of the line. If the AI put the cue on the line before and the next line is an action line `( … )` that mentions the roar, the player moves the cue to that action line. Pops on lines that never mention a roar still play at the start of the line, as before.

## Collapsible segments in the event builder
Every segment on the Show Card (CEO Office → edit event) has a ▾/▸ button. Collapsed, a segment shrinks to one headline row: its number, type, title and wrestlers (for a match "Alpha vs. Bravo"), the result if one is set, and the script beat count. The ↑ ↓ and Remove buttons stay on that row. Collapse all / Expand all sit above the list. Collapsing only hides the card, so nothing changes or is lost and the event saves as normal; collapsed state is not saved, so the page always opens expanded, and moving, adding or removing segments keeps the others as they were.

## No commercial breaks
The show has no commercial breaks, so the AI is told never to write "welcome back", "we're back" or "after the break" at the start of a segment; the announcers just carry on and go straight into the next segment. This is a Worker prompt change, so it applies to scripts generated after the Worker is redeployed. Scripts already written keep their text.

## How an entrance theme is found
A theme is matched by wrestler id first, then by ring name. The ring-name match ignores case, quotes and punctuation, and allows extra words around the name (so a key of `sweardog mckraken` also matches “Sweardog McKraken Jr.”). The manifest lists Sweardog under both spellings, McKraken and McKracken. If a theme still doesn't play, the key in `docs/audio/sounds.json` doesn't match the wrestler's exact ring name or id: add a line for it.

## Segment headers on the live page
Only matches get a segment header. It is centered on the screen and shows each wrestler's whole portrait (the full 480×847 image, uncropped, about 200 px wide; 150 px for a three-way, 92 px for a four-way, and stacked in a column on phones for three or more sides), with the Match tag, title and stipulation centered underneath. The public card on the Mayhem page keeps its small tiles. Promos, interviews, backstage scenes, angles and ceremonies have no header and the text simply starts. The show intro keeps its logo banner. This only changes what viewers see; the event builder still lists every segment.

## Mayhem logo size
The Mayhem logo (`docs/img/mayhem.webp`, 800 px wide) shows at up to 480 px on the Mayhem page, the show's start screen and the show-intro banner. Premium live event logos stay at their old size because those images are only about 388 px wide and would look soft if enlarged. The small logo in the Later Shows list is unchanged.
