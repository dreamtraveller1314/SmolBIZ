# SmolBIZ

A small-business operations app: onboarding, sales & product tracking, AI sales
insights, worker attendance (GPS + photo), team chat with automatic calendar
scheduling, and B2B collaboration discovery. Plain HTML/CSS/JS — no build step —
backed by Supabase (auth, database, storage, realtime) and Groq for AI insights.

## What's simplified vs. the original spec

You asked to get this working end-to-end quickly, so a few of the harder pieces
are simplified for now — they're structured so you can upgrade them later:

- **Facial recognition** → the app takes a photo at clock-in/sale time as visual
  proof (via the browser camera) but does not run real face matching. Real face
  match would need a service like AWS Rekognition or a face-embedding model.
- **GPS geofencing** → uses the browser's `navigator.geolocation` and a straight-line
  distance check against the business's saved coordinates. Good enough for "is this
  worker near the shop," not survey-grade.
- **Google Calendar sync** → events live in your own Supabase `events` table and
  render on an in-app Calendar tab, rather than actually syncing to Google Calendar
  (that requires OAuth + a backend to hold refresh tokens).
- **Barcode scanner** → left out for now; products are selected from a dropdown or
  by SKU text field instead.
- **Chatbot NLP** → a lightweight regex-based parser (`parseMeetingIntent` in
  `js/utils.js`) looks for phrases like "meeting tomorrow at 4pm" and creates a
  calendar event. It's not a real NLP model, but it's genuinely functional for
  common phrasing. Swap it for a Groq call if you want it smarter.

Everything else (auth, onboarding, roles, dashboard KPIs, transactions, products,
worker management, permissions, real-time chat, settings) is fully wired up.

---

## 1. Create your Supabase project

1. Go to [supabase.com](https://supabase.com) → sign in → **New project**.
2. Pick an organization, name it (e.g. `smolbiz`), set a database password (save it),
   choose a region close to you, and click **Create new project**. Wait ~2 minutes.
3. In the left sidebar go to **Project Settings → API**. Copy:
   - **Project URL** → goes into `SUPABASE_URL` in `js/config.js`
   - **anon public** key → goes into `SUPABASE_ANON_KEY` in `js/config.js`

## 2. Create the database tables

1. In the Supabase dashboard, open **SQL Editor → New query**.
2. Open `schema.sql` from this project, copy the whole file, paste it in, click **Run**.
3. This creates all tables, row-level security policies, and a public storage
   bucket called `smolbiz-media` (used for logos, sale photos, and attendance photos).

## 3. Turn off email confirmation (for local testing)

By default Supabase requires users to click a confirmation email before they can
log in, which will block this app's signup flow until you wire up an email
provider. For testing:

1. **Authentication → Providers → Email**.
2. Turn **Confirm email** off.
3. Save.

(Turn it back on before letting real strangers sign up.)

## 4. Get a Groq API key (optional but recommended)

1. Go to [console.groq.com/keys](https://console.groq.com/keys) → sign in → **Create API key**.
2. Copy it into `GROQ_API_KEY` in `js/config.js`.

If you skip this, the AI Insight box on the dashboard still works — it falls back
to a locally-generated summary instead of calling Groq.

> **Security note:** this prototype calls Groq directly from the browser, so the
> key is visible in your page's network requests. That's fine to develop with, but
> before sharing this with real users, move the `fetch()` call in `js/groq.js`
> into a Supabase Edge Function so the key stays server-side.

## 5. Set up your keys with `.env`

Keys are generated into `js/config.js` automatically from environment
variables — you never hand-edit `config.js` directly, and it's git-ignored so
it's never committed.

**Locally:**

```bash
cp .env.example .env
```

Open `.env` and fill in your real values:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
GROQ_API_KEY=your-groq-key
GROQ_MODEL=llama-3.3-70b-versatile
ATTENDANCE_RADIUS_METERS=200
```

Then generate `js/config.js` from it:

```bash
node scripts/generate-config.js
```

(This has no npm dependencies — it's plain Node, so no `npm install` needed.)
Re-run this command any time you change `.env`.

**On Render**, you won't use `.env` at all — Render injects environment
variables directly into the build. See the Deploying section below.

## 6. Run it locally

Because the app uses ES module imports, you need to serve it over `http://`
rather than opening `index.html` directly as a `file://` URL.

Make sure you've run `node scripts/generate-config.js` at least once (step 5),
then from this folder:

```bash
# Python (built into macOS/Linux, or `python` on Windows)
python3 -m http.server 8080

# or Node
npx serve .

# or, if you have npm available, this does both steps for you:
npm start
```

Then open `http://localhost:8080`.

## 7. Try the flow

1. **Sign up** as an admin (any email/password) → pick a business type → fill in
   the business profile → optionally invite a worker by email → land on the
   dashboard.
2. Add a product, log a sale, log an expense — watch the KPIs and AI insight update.
3. To test the **worker flow**: invite a worker email from Worker Management (or
   during onboarding), then sign up with that exact email in a different browser
   / incognito window — it'll detect the invite and drop them straight into the
   worker view instead of the admin onboarding wizard.
4. In **Chat & Calendar**, type something like `Meeting tomorrow at 4pm` — it'll
   post the message and automatically create a calendar event.

---

## Deploying

This is a static site (HTML/CSS/JS), so it deploys anywhere that serves static
files — Render, Netlify, Vercel, GitHub Pages, etc.

### Deploying on Render

1. Push this folder to a GitHub repo. `.env` and `js/config.js` won't be
   included (they're git-ignored) — that's expected.
2. In Render: **New → Static Site**.
3. Connect the repo.
4. **Build Command:** `node scripts/generate-config.js`
5. **Publish Directory:** `.` (the repo root, where `index.html` lives).
6. Before deploying, go to the **Environment** tab for this service and add
   each variable from `.env.example` as a real environment variable:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `GROQ_API_KEY`
   - `GROQ_MODEL`
   - `ATTENDANCE_RADIUS_METERS`
7. Deploy. Render runs the build command, which generates `js/config.js` from
   those variables right before serving the site. Render will give you a
   `https://your-app.onrender.com` URL.

Any time you update a key in Render's Environment tab, trigger a new deploy
(Render does this automatically on env var changes, or you can click **Manual
Deploy**) so the build step regenerates `config.js` with the new value.

Keep in mind: the Supabase anon key and Groq key still end up inside the
JavaScript that ships to the browser — that's unavoidable for a pure client-side
app. Using `.env` + Render's Environment tab keeps keys out of your git history
and makes rotating them easy, but it doesn't make them a server-side secret. For
real secrecy on the Groq key, see the Edge Function note above.

---

## Project structure

```
index.html                  entry point
package.json                convenience npm scripts (build, start)
.env.example                 template for your keys — copy to .env
.gitignore                   keeps .env and js/config.js out of git
scripts/generate-config.js   reads .env / Render env vars → writes js/config.js
css/style.css                all styling (design tokens at the top)
js/config.js                 AUTO-GENERATED — do not edit by hand
js/supabaseClient.js         Supabase client setup
js/state.js                  shared in-memory app state
js/utils.js                  helpers: formatting, toast messages, meeting-intent parser
js/auth.js                   welcome/login/signup + admin onboarding wizard + worker join
js/shell.js                  sidebar/nav shell shared by admin & worker views
js/admin.js                  admin dashboard, sales/products, collab, worker mgmt, settings
js/worker.js                 worker home (attendance + sales entry), settings
js/chat.js                   real-time chat + calendar (NLP meeting detection)
js/groq.js                   Groq API calls for AI insight + simple sales forecasting
js/main.js                   boots the app, handles routing
schema.sql                   run once in Supabase SQL editor
```

## Where to go next

- Swap the regex meeting-parser for a real Groq call for smarter chat scheduling.
- Add a Supabase Edge Function to proxy Groq calls (keeps your API key private).
- Add real Google Calendar sync via OAuth if you need events to show up in Google.
- Add barcode scanning with a library like `@zxing/browser` for the product checkout flow.
- Swap the photo-only attendance check for a real face-match API if you need stronger identity verification.
