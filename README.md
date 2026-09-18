# HN Digest

A TypeScript service that publishes Chinese Hacker News article and discussion summaries to Telegram, with a single Telegraph Instant View page for each story.

## Run

Requires Node.js 24 or later. Copy `.env.example` to `.env.local`, populate credentials, then run:

```sh
npm ci
npm test
npm run build
node --env-file=.env.local dist/server.js
```

All secrets belong in ignored local configuration or Railway Variables. Never put tokens in command arguments, source files, or issue reports.

## Behavior

- Polls the first 30 HN top stories every 10 minutes; publishes stories scoring at least 150. At most three new stories per cycle, including initial startup.
- Extracts HTML with Mozilla Readability. Documents that cannot be extracted (including unsupported PDFs and paywalls) are explicitly marked unavailable. HN text posts are supported. It never substitutes a guessed article summary.
- Samples up to 160 live comments, retaining parent IDs, with a 48,000-character total budget and a 2,500-character per-comment cap. Sampling is breadth-first, not vote-ranked; HN does not expose comment scores.
- Generates structured Simplified Chinese output through OpenRouter. Validates citations against the exact supplied comments and renders separate article and discussion sections. Telegraph content stays below its 64 KB limit.
- Refreshes score/comment metadata for 48 hours after publication. When comments grow by 30 or more, regenerates summaries at most hourly and at most three times per story. It edits the original Telegraph page and Telegram message.
- The reading estimate describes the source article (220 words or 400 Han characters per minute). A fire marker is shown at 400 points; this is an explicit product rule, not a claim about the reference channel's hidden implementation.

## Railway

Deploy the Dockerfile as one persistent service with **one replica** and a volume mounted at `/data`. Set all required variables from `.env.example`. Set the health check path to `/healthz`, use port 3000, and keep `AUTO_PUBLISH=false` until the initial publication is checked. No cron service is necessary; the application owns its scheduler.

The SQLite volume retains drafts, Telegraph paths, Telegram message IDs, retry state, scheduler settings, and a process lease. The deployment archive excludes local secrets, data, and artifacts. Back up the volume through Railway before any destructive maintenance. This repository does not configure a backup schedule.

## Operations

`GET /healthz` is public and returns only process health. Every `/admin/*` route requires `Authorization: Bearer <ADMIN_TOKEN>`. Avoid putting this token in URLs.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/admin/status` | Publication IDs, delivery state, page URLs, sampled comment counts, and last cycle |
| POST | `/admin/preview/:hnId` | Generate and persist a draft without publishing externally; `?regenerate=true` replaces only an unpublished draft with no page |
| POST | `/admin/publish/:hnId` | Publish a saved draft or generate one; an already-published ID is a no-op |
| POST | `/admin/run` | Start one background cycle, even while automatic scheduling is paused |
| POST | `/admin/enable` | Persistently enable automatic publishing |
| POST | `/admin/pause` | Pause future automatic cycles; an active cycle drains normally |

Automatic mode is stored in SQLite once changed through the admin API and then overrides the environment default. API preview is protected because it spends model credits. The published Telegraph page is public; no Telegram invitation token is embedded in it.

## Delivery guarantees and recovery

Known Telegram rejections return to `ready` and retry with exponential backoff. Network errors or a process interruption during `sendMessage` become `uncertain` and **are not automatically resent**. Telegram Bot API has no client idempotency key, so claiming exactly-once delivery would be inaccurate.

If `/admin/status` reports `uncertain`, first inspect the target channel. Reconcile the SQLite publication with the actual message ID if it exists; only reset it to `ready` after verifying no message was delivered. Stop the worker before manual database repair. No unauthenticated reset endpoint is exposed.

If Telegraph page creation succeeds but the response is lost, a later attempt can leave an orphan Telegraph page; it will not cause a duplicate channel message. If an edit response is lost, the next metadata edit is safe to repeat. Instant View clients may cache a page; edits need client-side readback before claiming immediate refresh.

## Verification

The tests cover database reopening, definite send rejection, ambiguous send outcomes, interrupted delivery, same-page discussion refresh, deleted comments, source references, HTML escaping, private-address blocking, and non-publishing previews. Live acceptance must additionally verify OpenRouter, Telegraph, the target Telegram channel, and persistence after a Railway restart.

## Reuse

Uses the official Hacker News, Telegram Bot, and Telegraph HTTP APIs, Mozilla Readability, jsdom, Zod, and undici. The earlier `hacker-news-worker` research informed the scope, but its Cloudflare-specific delivery implementation was not copied: Railway persistence and recoverable delivery need different state handling.

See [live acceptance](docs/acceptance.md) for the deployment and verification evidence.
