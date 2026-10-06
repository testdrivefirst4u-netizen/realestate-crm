# Amaya CRM v3 — Next.js + MongoDB

The Amaya by Vera Vita sales CRM, moved off Google Sheets + Apps Script onto **Next.js 16 (App Router)**,
**Tailwind CSS v4** and **MongoDB**. Every screen and feature of v2 is kept. The browser still calls the same
69 backend actions, now served by Next.js from MongoDB instead of an Apps Script web app.

```
app/                 Next.js routes
  (crm)/             the CRM: one route per screen (/dashboard, /leads, /kanban, /followups, …; ?lead=ENQ-0001 opens a lead)
    layout.tsx       server: validates the session (→ /login) and the screen's plan/role gate, renders the shell
    _components/     CrmShell — data engine, sidebar, top bar, overlays; screens read it with useCrm()
    <view>/          page.tsx (server: title + gate) · <View>Client.tsx (the screen)
  login/             sign-in (?next= returns to the requested screen)
  superadmin/        platform console
  api/rpc            POST {action, data} → {status, data} — all CRM actions
  api/files/[id]     uploaded files (GridFS), session-checked
  api/reports/[id]   report snapshot CSV download
  api/webhooks/      chat360 · telephony (shared-secret authenticated)
  api/cron/          followups (hourly) · daily (housekeeping + digest) · sheets · meta (every 5 min), Bearer CRON_SECRET
                     Vercel Hobby runs each once a day (vercel.json); .github/workflows/cron.yml calls them on schedule
  api/health         uptime check
proxy.ts             passes the requested URL to the CRM layout (for /login?next=)
server/
  core/              config · db (MongoDB, counters, data version) · auth · settings/secrets · events/timeline · leadShape
  core/pageSession   session + screen gate for server-rendered pages
  modules/           leads · tasks · inventory · records · storage · reports · chat360 · calls · ai · jobs · system
  router.ts          action registry + permission checks
src/                 React UI (ported from v2)
scripts/             create-admin · migrate-from-sheets
tests/               vitest — UI logic + server modules against a real in-memory MongoDB
```

## Multi-company SaaS

The app is multi-tenant: a **platform super admin** creates and manages companies at **`/superadmin`**;
each company gets its **own MongoDB database** (`crm_<slug>`), its own users, settings, API keys and
webhooks. A platform database (`PLATFORM_DB`, default `amaya_platform`) holds the companies, plans,
super admins, the platform audit log and the e-mail → company directory (one sign-in page for everyone).

- **Isolation:** every request runs inside one company (`server/core/tenant.ts`). Database access without
  a company throws. The session cookie is `<companyId>.<token>`, and the token is only valid in that
  company's database.
- **Plans:** set a user limit (`maxUsers`, 0 = unlimited) and features (AI, WhatsApp, calls, inventory,
  unit locator, Amaya project library, reports, segments). Disabled features are hidden in the UI and
  refused by the API.
- **Suspend:** sign-in is blocked and every session ends. **Delete:** drops the company database and
  frees its e-mails and slug.
- **Webhooks:** `/api/webhooks/{chat360|telephony}?company=<slug>&secret=…`. Cron jobs run once per active company.
- **Billing:** plans carry a display price only; there is no payment gateway yet.

### Lead sources (website forms & webhooks)

Settings → Lead sources (or the super admin, per company) creates a **source** (`website` or `webhook`) with
its own API key `crm_live_…`. The key is shown **once**; only its SHA-256 is stored, and it identifies the
company by itself. Needs the plan feature **websiteApi**.

`POST /api/inbound/leads` — key in `Authorization: Bearer <key>`, `X-Api-Key`, a `_key` field or `?_key=`.
Body: JSON, urlencoded or multipart (≤ 100 KB, files ignored). Common names are recognised (`name`,
`first_name`+`last_name`, `phone`/`mobile`/`whatsapp`, `email`, `message`/`comments`, `bhk`/`unit_type` …);
everything else (incl. `utm_*`, `gclid`, `page_url`) is appended to *Enquiry Notes*; a per-source field map
can override this. A phone (≥ 7 digits) or an e-mail is required. Existing phone/e-mail → a follow-up remark on
that lead (or skip / create, per source). Assignment: unassigned, fixed RM or round robin.

- `201 {status:'success', data:{leadId, duplicate}}`; `400` invalid · `401` unknown key · `403` paused source,
  plan without the feature or an Origin not in the source's allowed origins · `429` over 60/min per key or
  20/min per IP.
- `_gotcha` honeypot (keep it empty and hidden), `_redirect=https://…` (on an allowed origin → `303` with
  `?lead=ok|error`), `Idempotency-Key` header or `_submission_id` field (repeat = same result, no new lead).
- Every submission is logged for 180 days (Settings → Lead sources → log); failed ones can be retried.

```html
<form action="https://crm.example.com/api/inbound/leads" method="POST">
  <input type="hidden" name="_key" value="crm_live_…">
  <input type="hidden" name="_redirect" value="https://www.example.com/thank-you">
  <input type="text" name="_gotcha" style="display:none" tabindex="-1" autocomplete="off">
  <input name="name" placeholder="Name" required>
  <input name="phone" placeholder="Phone" required>
  <input name="email" type="email" placeholder="E-mail">
  <textarea name="message"></textarea>
  <button>Send</button>
</form>
```

A key in a public form can be read by anyone — restrict the source's **allowed origins**, and rotate the key if
it is abused. Server-to-server (webhooks, Zapier, landing-page builders):

```bash
curl -X POST https://crm.example.com/api/inbound/leads \
  -H "Authorization: Bearer crm_live_…" -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-1234" \
  -d '{"name":"Asha Rao","phone":"+91 98765 43210","email":"asha@example.com","message":"2 BHK","utm_source":"google"}'
```

### Google Sheets (import & export)

One **platform** Google service account reads and writes the sheets of every company (plan feature
**googleSheets**). Setup in Google Cloud, once:

1. Create (or pick) a project at console.cloud.google.com.
2. *APIs & Services → Library* → enable **Google Sheets API**.
3. *IAM & Admin → Service accounts* → create a service account (no roles needed).
4. Open it → *Keys → Add key → Create new key → JSON* and download the file.
5. Paste the JSON in **Super Admin › Platform settings › Google** (stored encrypted with
   `SECRETS_ENCRYPTION_KEY`; *Test* fetches a token) — or set `GOOGLE_SERVICE_ACCOUNT_JSON` (the JSON, or
   base64 of it). A key saved in the console wins over the environment.

Companies then **share each sheet with the service account's e-mail** (shown in Settings): *Viewer* is enough
to import, *Editor* is needed to export and to write the import status column. A spreadsheet can be linked to
one company only.

- **Import** = a lead source of type `google_sheet`: header row (1–20) + data rows below it go through the
  same pipeline as website forms (field recognition, field map, duplicates, assignment, intake log). With a
  *status column* the CRM imports rows whose status cell is empty and writes back "Imported ENQ-0042 · …" /
  "Duplicate of …" / "Rejected: …" (clear the cell to re-import a row); without one it imports the rows after
  the last imported row. Up to 2,000 rows per run; re-runs never create a lead twice.
- **Export** = the whole tab (default "CRM Leads", created if missing) is rewritten with one row per lead
  (values written as plain text — formulas are never executed). Use a dedicated tab.
- `GET /api/cron/sheets` (every 5 minutes) runs due imports and exports (an export only when data changed);
  intervals 5 / 15 / 60 minutes or manual.

#### Connect with Google (no key file)

Instead of sharing sheets with the service account, a company admin can click **Connect with Google** in
Settings › Google Sheets and sign in with their own Google account; each import/export then chooses *Access via*
the platform service account or one of the company's connected accounts. The refresh token is stored encrypted
per company; *Disconnect* revokes it at Google (links still using it are paused). Setup in Google Cloud, once,
by the platform owner (same project as above, Google Sheets API enabled):

1. *APIs & Services → OAuth consent screen*: user type **External**, app name, user support e-mail and developer
   e-mail; scopes: add `…/auth/spreadsheets` (plus `openid` and `email`). While the app is in **Testing**, add
   the Google accounts that will connect as **Test users** (up to 100).
2. *APIs & Services → Credentials → Create credentials → OAuth client ID* → application type **Web
   application** → *Authorised redirect URIs*: the URI shown in **Super Admin › Platform settings › Google**
   (`https://<APP_URL>/api/integrations/google/callback`; `http://localhost:3000/api/integrations/google/callback`
   works for local testing).
3. Paste the **Client ID** and **Client Secret** in **Super Admin › Platform settings › Google** (the secret is
   stored encrypted and never shown again) — or set `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`
   (a client saved in the console wins).

Notes: `spreadsheets` is a **sensitive scope** — Google must verify the app before it can be published to
everyone (until then only test users can connect and see an "unverified app" warning). In **Testing** mode
refresh tokens **expire after 7 days**: the connection then shows "Google access was revoked or expired —
reconnect the Google account", the links using it record that message, and *Connect with Google* again with the
same account fixes it (other links keep running). If Google returns no offline access, remove the app at
myaccount.google.com/permissions and connect again.

### Meta Lead Ads (Facebook / Instagram)

One **platform** Meta app receives the leads of every company (plan feature **metaLeads**). Each company
connects its own Facebook Pages; each connected Page becomes a lead source of type `meta`. A Page can be
connected to one company only.

**Meta app setup** (developers.facebook.com, once, by the platform owner):

1. *Create app* → type **Business**, attached to your Business portfolio.
2. Add the products **Facebook Login for Business** and **Webhooks**.
3. **Webhooks** → object **Page** → *Callback URL* `https://<APP_URL>/api/webhooks/meta`, *Verify token* =
   the token shown in **Super Admin › Platform settings › Meta** (generate it there first) → *Verify and save*
   → subscribe to the field **`leadgen`**.
4. **Facebook Login for Business › Settings** → *Valid OAuth Redirect URIs*:
   `https://<APP_URL>/api/integrations/meta/callback`. Optionally create a *Configuration* (user access token,
   the permissions below) and paste its id as *Login configuration id*; without one the classic `scope`
   parameter is used.
5. Permissions (App Review → advanced access): `leads_retrieval`, `pages_show_list`, `pages_read_engagement`,
   `pages_manage_metadata`, `pages_manage_ads`, `business_management`. This needs **Business verification**,
   **App Review** (screencast of the connect flow), a **Privacy policy URL** and a **Data deletion** URL /
   instructions in *App settings › Basic*, and the app switched to **Live**.
6. In **Super Admin › Platform settings › Meta** enter the App ID and App Secret (stored encrypted with
   `SECRETS_ENCRYPTION_KEY`, never shown again; *Test* requests an app token) — or set `META_APP_ID`,
   `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_GRAPH_VERSION` (default `v23.0`), `META_LOGIN_CONFIG_ID`.
   Values saved in the console win over the environment.
7. Test with the **Lead Ads Testing Tool** (developers.facebook.com/tools/lead-ads-testing): create a test lead
   for a connected Page/form — it should appear in the CRM within seconds.

**Each client** connects in *Settings › Lead sources › Connect with Facebook* (admin, plan metaLeads), picks
the Pages (and optionally the forms). The person logging in needs **admin or advertiser** access to the Page
(Page tasks MANAGE or ADVERTISE). If the client's Business uses the **Leads Access Manager**, they must allow
the CRM app in **Meta Business Suite › Settings › Integrations › Leads Access › CRM access** — otherwise Facebook
refuses to return the leads. The super admin can also connect a Page for a company with a Page access token.

How leads flow: the webhook verifies `X-Hub-Signature-256`, queues the lead id (platform `metaLeadQueue`) and
answers at once; the lead is then fetched from the Graph API and goes through the normal intake pipeline
(field map, duplicates, assignment, intake log) with ad / ad set / campaign / form / platform in the notes.
`GET /api/cron/meta` (every 5 minutes) retries failed leads (after 5 / 15 / 60 / 240 minutes, then gives up)
and once a day re-reads the last 2 days from every connected form; leads are never created twice.

### First-time setup (against your database)

```bash
npm run create-superadmin -- you@example.com "Your Name"           # prints a temporary password once
# register the existing Amaya database as the first company (nothing is copied or changed):
npm run create-company -- --name "Amaya by Vera Vita" --slug amaya --plan enterprise \
  --admin-email rahul@veravitaliving.com --admin-name "Rahul" --adopt-db amaya_crm --features unitLocator,projectLibrary
```

Then sign in at `/superadmin` to create further companies (each with its first admin). Company users sign
in at `/`. Other scripts take the company: `create-admin -- --company <slug> …`,
`migrate:sheets -- <file.xlsx> --company <slug>`. In production, web-based super-admin setup also requires
`PLATFORM_SETUP_TOKEN`; the script is the recommended path.

## Run locally

```bash
npm install
npm run dev            # http://localhost:3000
```

With no `MONGODB_URI` set, development starts a local MongoDB automatically (data kept in `./.data`).
The first visit shows **first-run setup** to create the administrator.

Quality gates: `npm run typecheck` · `npm test` (376 tests) · `npm run build`.

## Configuration (`.env.local`, see `.env.example`)

| Variable | Purpose |
|---|---|
| `MONGODB_URI`, `MONGODB_DB` | MongoDB Atlas connection (required in production) |
| `APP_URL` | Public URL, used for the webhook URLs shown in Settings → Integrations |
| `CRON_SECRET` | Protects `/api/cron/*` (Vercel Cron sends it automatically) |
| `SECRETS_ENCRYPTION_KEY` | Encrypts API keys saved from Settings and the Google service account (32+ random characters) |
| `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_GRAPH_VERSION`, `META_LOGIN_CONFIG_ID` | Optional: the Meta app for Lead Ads, if not entered in Super Admin |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Optional: Google service-account key (JSON or base64) for Google Sheets, if not pasted in Super Admin |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Optional: the OAuth client for "Connect with Google" (Google Sheets), if not entered in Super Admin |
| `GEMINI_API_KEY`, `CHAT360_API_KEY`, `CHAT360_WEBHOOK_SECRET`, `TELEPHONY_WEBHOOK_SECRET` | Optional: set here instead of in Settings; an environment value always wins and is shown as read-only |
| `AI_DAILY_LIMIT` | AI requests per user per day (default 300) |
| `SMTP_URL`, `MAIL_FROM` | Optional: daily digest e-mail |
| `SETUP_TOKEN` | Optional: require this token for first-run setup on a fresh production database |

## Deploy (Vercel + MongoDB Atlas)

1. Create an Atlas cluster (M10+ recommended for backups / point-in-time restore); add a database user;
   allow Vercel's egress (or 0.0.0.0/0 with a strong password).
2. Import this folder (`next-app/`) as a Vercel project; set the environment variables above.
   `vercel.json` registers the two cron jobs.
3. Deploy, open the site, create the administrator (or run `npm run create-admin -- you@example.com "Name"`).
4. In Settings → Integrations, enter the Gemini / Chat360 keys and generate webhook secrets, then paste
   the shown webhook URLs into Chat360 and the telephony provider.

## Move the data from the Google Sheet

1. In the CRM spreadsheet: **File → Download → Microsoft Excel (.xlsx)**.
2. Point `MONGODB_URI` at the production database, then:
   ```bash
   npm run migrate:sheets -- ./Amaya-CRM.xlsx --dry-run   # counts + warnings, writes nothing
   npm run migrate:sheets -- ./Amaya-CRM.xlsx             # import (refuses if data exists; --wipe to redo)
   ```
3. Users keep their passwords (old hashes are upgraded to bcrypt at first sign-in). Id counters continue after
   the highest imported id. Uploaded files and call recordings stay in Google Drive; their links are kept.
   Sessions, Code Versions and Report Snapshots are not imported. API keys must be re-entered.

Cut-over: freeze the sheet (view-only), run the final import, switch the Chat360/telephony webhooks, go live.
Rollback: point the webhooks back at Apps Script and reopen the sheet.

## What changed from v2 (security & reliability)

- **Auth:** bcrypt passwords (10+ characters), session token only in an httpOnly cookie (stored hashed),
  login lockout after repeated failures, same message for every failed sign-in, other sessions signed out on
  password change.
- **Browser storage:** no customer data is cached in the browser any more, only UI preferences.
- **Secrets:** AES-256-GCM encrypted at rest, or provided by the environment. The Chat360 base URL is locked
  to chat360.io, and digest recipients must be CRM users.
- **Developer Mode removed:** no live code editing from the browser; changes go through Git → CI → Vercel.
- **Ids:** an atomic counter issues every id, so a deleted id is never reused.
- **No global lock:** writes use conditional updates; the bulk import is batched, with no per-row full-sheet reads.
- **AI:** model allow-list, token caps, size limits and a per-user daily quota.
- **Webhooks:** constant-time secret check, accepted from a header or a query string. Duplicate deliveries are
  ignored by a unique index. Transcription no longer runs inside the provider's request.
- **Files:** GridFS with a MIME allow-list and size limit, served only to signed-in users. SVG is downloaded,
  never rendered inline.
- **Real URLs:** back/forward, refresh and shareable lead links work. Security headers are set in `next.config.ts`.
