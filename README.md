

# autogtm

**autogtm is an open-source AI GTM engine that runs cold outbound on autopilot.**

Describe your target audience in plain English with optional targeted briefs, and autogtm discovers leads daily, enriches them with AI, creates tailored email campaigns, and sends via Instantly. System on, autopilot on, you sleep.

---

## How it works

1. **You set context** — fill in the Company Profile so the AI can search broadly. Optionally add **Lead Briefs** to pinpoint specific kinds of leads ("acting coaches on TikTok with 10k+ followers").
2. **Choose execution mode per brief**:
  - `Queue`: picked up by scheduled generation/run.
  - `Run now`: generates and starts search immediately.
3. **AI generates search queries** from your context + briefs.
4. **Exa runs search and extracts leads** with enrichment hints.
5. **AI enriches leads** (bio, fit score, contact context).
6. **AI creates a draft campaign per lead** for review.
7. **Approve and send** — either you manually review and click "Create and Start Campaign", or **Autopilot** sweeps the backlog at the configured hour (default 10am ET) and keeps filling remaining daily quota as more leads become ready.
8. **Instantly status + analytics sync hourly**; daily digest summarizes what went out.

### Controls


| Toggle               | What it does                                                                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **System ON/OFF**    | Master switch. When OFF, nothing runs. No searches, no enrichment, no campaigns. Turning this off also pauses Autopilot.                                                                                                                |
| **Autopilot ON/OFF** | When ON, at the configured hour (default 10am ET) the top N Ready-to-Add leads (fit-score threshold + daily limit) are auto-added to their suggested campaigns. Remaining quota is filled later the same day as more leads qualify. A digest email summarizes the scheduled sweep. Configure in the Autopilot tab. |


### Daily schedule


| Time          | What happens                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| Hourly (:00)  | Generate queued briefs; at most one exploration query per company per UTC day                         |
| Hourly (:20)  | Run pending searches (max 3 per company per day), then enrich and score leads                         |
| Configured hour (default 10:00 AM ET) | **Autopilot sweep** — auto-add top N Ready-to-Add leads + digest email (when enabled) |
| Later same day | Autopilot catch-up fills remaining daily quota as enrichment finishes (no extra digest)             |
| Hourly        | Sync campaign status and analytics from Instantly                                                     |
| 2:00 PM ET    | Send daily discovery digest email                                                                     |


---

## Features

- **AI lead discovery:** Exa.ai websets find people matching your natural-language description.
- **AI enrichment:** Bio, social links, audience size, expertise tags, and a 1-10 fit score with reasoning.
- **AI email copywriting:** Personalized multi-step sequences generated per lead draft.
- **Campaign management:** Draft-first campaigns with controlled start in Instantly.ai.
- **System + Autopilot toggles:** Company-level master switch plus a daily Autopilot sweep that auto-adds the top N qualifying leads each morning (configurable daily limit, minimum fit score, and digest email).
- **Fresh-copy Autopilot:** Optional "regenerate draft before adding" — rewrites each draft's sequence against the lead's bio/expertise right before sending so stale templated copy never goes out.
- **Exploration mode:** When no new briefs exist, AI generates creative queries to keep pipeline coverage fresh.
- **Daily digests:** Two summary emails — a per-company Autopilot digest (what was auto-added and to which campaigns) and a global discovery digest (leads found, emails sent, opens, replies).
- **Multi-company:** Manage multiple company profiles from a single dashboard.

## Stack


| Layer           | Technology                                                                          |
| --------------- | ----------------------------------------------------------------------------------- |
| Framework       | [Next.js 15](https://nextjs.org) (App Router)                                       |
| Frontend        | React 19, [Tailwind CSS](https://tailwindcss.com), [Radix UI](https://radix-ui.com) |
| Database + Auth | [Supabase](https://supabase.com) (PostgreSQL + Auth)                                |
| Background Jobs | [Inngest](https://inngest.com)                                                      |
| Lead Discovery  | [Exa.ai](https://exa.ai) (Websets API)                                              |
| Email Sending   | [Instantly.ai](https://instantly.ai)                                                |
| AI              | [OpenAI](https://openai.com) (GPT-4.1 / GPT-5-mini)                                 |
| Digest Emails   | [Resend](https://resend.com)                                                        |


---

## Getting Started

### Prerequisites

Accounts needed:

- [Supabase](https://supabase.com) — database and authentication
- [Exa.ai](https://exa.ai) — lead discovery via Websets API
- [Instantly.ai](https://instantly.ai) — email campaign sending
- [OpenAI](https://platform.openai.com) — AI enrichment and generation
- [Inngest](https://inngest.com) — background jobs (self-hosted in Docker / CLI, or Inngest Cloud)
- [Resend](https://resend.com) — daily digest emails (optional)

Locally: Node.js 20+ and npm. [Docker](https://docs.docker.com/get-docker/) if you use the Compose stack. `@supabase/supabase-js` 2.110+ requires Node 22, so this repo pins `2.109.0`.

### Supabase (required)

Create a project at [supabase.com](https://supabase.com) (or [self-host Supabase](https://supabase.com/docs/guides/self-hosting/docker)), then:

1. Open **SQL Editor**
2. Paste `[schema.sql](./schema.sql)` and run it

This creates all required tables, indexes, RLS policies, and helper functions.

If you already have a project from an earlier version, apply incremental migrations from `[migrations/](./migrations/)` instead — they are safe to re-run (`IF NOT EXISTS` guarded).

In **Authentication → URL Configuration**:

- **Site URL:** your app origin (`http://localhost:3200` locally, `https://your.domain` in production)
- **Redirect URLs:** `{origin}/auth/callback` and `{origin}/login`

### Local development

```bash
git clone https://github.com/TechStack-Softwares/autogtm.git
cd autogtm
npm install

cp apps/autogtm/.env.example apps/autogtm/.env.local
# Fill in values in .env.local

npm run dev
```

The app runs at [http://localhost:3200](http://localhost:3200).

For background jobs (including **Run now** on a lead brief), start the Inngest dev server in a second terminal:

```bash
npm run dev:inngest
# or: npx inngest-cli@latest dev
```

Do **not** set `INNGEST_DEV=0` or `INNGEST_BASE_URL` in `apps/autogtm/.env.local` for this setup. Those are only for self-hosted Inngest (`docker compose` or `inngest-cli start`). With them set, `inngest.send()` talks to `localhost:8288` in production mode and fails with `ECONNREFUSED` if that server is not running.

## Self-hosting

Docker Compose runs the Next.js app plus a self-hosted [Inngest](https://www.inngest.com/docs/self-hosting) server (Postgres + Redis for job state). You still need accounts for **Exa**, **Instantly**, **OpenAI**, and optionally **Resend** — those APIs have no in-repo replacements.

**What this stack hosts**

| Service | Where it runs |
| --- | --- |
| Next.js app | `app` container, port 3200 |
| Inngest (jobs + dashboard) | `inngest` container, port 8288 |
| Inngest Postgres / Redis | local volumes, not published |
| Database + Auth | your Supabase project (cloud or official self-hosted Docker) |

```bash
cp .env.example .env
```

Fill in `.env`:

1. **Supabase** URL and keys from Project Settings → API Keys.
2. **Inngest keys** — hex strings with an even length:

   ```bash
   openssl rand -hex 32
   python -c "import secrets; print(secrets.token_hex(32))"
   ```

   Use one value for `INNGEST_SIGNING_KEY` and a different one for `INNGEST_EVENT_KEY`.
3. **Exa / Instantly / OpenAI** API keys. Resend is optional (daily digests).
4. Set `NEXT_PUBLIC_APP_URL` to the public origin users will open (not `http://app:3200`).

Then:

```bash
docker compose up --build
```

- App: [http://localhost:3200](http://localhost:3200)
- Inngest dashboard: [http://localhost:8288](http://localhost:8288)

Create an account on `/login` with one of the `INVITE_CODES` from `.env`.

`NEXT_PUBLIC_*` variables are compiled into the image. Rebuild after changing Supabase URL, anon/publishable key, app URL, or Google client ID:

```bash
docker compose up --build
```

### Without Docker

You can run a production Node process and a local Inngest server instead of Compose.

```bash
cp apps/autogtm/.env.example apps/autogtm/.env.local
```

Set the same keys as above, plus:

```
INNGEST_DEV=0
INNGEST_BASE_URL=http://localhost:8288
```

Generate hex keys, then in two terminals:

```bash
npm install
npm run build

# terminal 1 — Inngest (dashboard at http://localhost:8288)
npx inngest-cli@latest start --sdk-url http://localhost:3200/api/inngest --event-key YOUR_EVENT_KEY --signing-key YOUR_SIGNING_KEY

# terminal 2 — app at http://localhost:3200
npm run start --workspace=autogtm
```

### Production notes

- Put the app behind HTTPS (Caddy, nginx, Traefik, or a managed reverse proxy). Point DNS at the host and set `NEXT_PUBLIC_APP_URL=https://your.domain`.
- Change `INNGEST_DB_PASSWORD` and both Inngest keys before exposing the host.
- Do not publish Inngest (`8288`) to the public internet unless you intend to. The app talks to it on the Docker network.
- Pin `inngest/inngest:latest` to a version tag once you are happy with a release.
- Fully private data plane: run [Supabase's Docker stack](https://supabase.com/docs/guides/self-hosting/docker) on the same host/VPC and set `NEXT_PUBLIC_SUPABASE_URL` to a URL the **browser** can reach (not an internal Compose hostname).

### Vercel (alternative)

You can still deploy the Next.js app to Vercel and use [Inngest Cloud](https://www.inngest.com) instead of the Compose Inngest service. Set the same environment variables in the Vercel project, connect the Inngest app to `/api/inngest`, and use a paid Supabase plan if you need higher limits.

## License

Licensed under [AGPL-3.0](LICENSE).

**TL;DR:** You can use it, change it, and ship it; if you run a modified version as a service (e.g. a hosted app), you must make that version’s source code available to your users.