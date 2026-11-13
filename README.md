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
150 words a minute plus the CEO's pauses, so nobody can read ahead, and promos and backstage segments appear only at that
moment. The CEO can preview a show at ×4–×16 speed from the Start screen. The show's start time uses its time zone field
(ET, CT, MT, PT or a name like `America/Chicago`; blank means Eastern). Viewing records live in a small `show_views` table
that the Worker creates by itself and clears after 3 days.
