# HN Digest

A TypeScript service that publishes Chinese Hacker News article and discussion summaries to Telegram, with a Chinese rewrite on a Telegraph Instant View page for each story.

## Run

Requires Node.js 24 or later. Copy `.env.example` to `.env.local`, populate credentials, then run:

```sh
npm ci
npm run verify
node --env-file=.env.local dist/server.js
```

All secrets belong in ignored local configuration or Railway Variables. Never put tokens in command arguments, source files, or issue reports.

## Behavior

- Polls the first 30 HN top stories every 10 minutes; publishes stories scoring at least 150. At most three new stories per cycle, including initial startup.
- Retrieves all external article sources through Firecrawl Scrape with the required `FIRECRAWL_API_KEY`; requests consume account credits. Scrape renders JavaScript, uses `proxy: "auto"`, and waits `waitFor: 1500` milliseconds before producing the article Markdown. Response status, text length, challenge pages, and gated subscription previews are checked before accepting a source. Rate limits honor `Retry-After` and a shared provider cooldown. HN text posts are read locally. Unretrievable sources remain explicitly unavailable and enter persistent recovery; automatic retrieval uses Firecrawl throughout, including historical reading candidates.
- Samples up to 160 live comments, retaining parent IDs, with a 48,000-character total budget and a 2,500-character per-comment cap. After the initial batch, sampling interleaves top-level comments with replies and prioritizes newly discovered reply chains so rebuttals can enter the sample before the top-level queue is exhausted. This is a bounded sample, not vote-ranked or exhaustive; HN does not expose comment scores.
- Discussion summaries group claims, rebuttals, and clarifications with citations for each side. The model receives sample coverage and missing-parent IDs, and must not infer missing context or confuse a story submitter with its author. Citation validation checks supplied IDs, not semantic support; real-output review remains necessary.
- Summary requests disable optional reasoning. `OPENROUTER_MAX_OUTPUT_TOKENS` defaults to 12,000 (allowed range: 1,000–64,000). It is an output ceiling, not a target length. Truncated or empty responses fail rather than being published. Models that require reasoning need a separate budget evaluation before switching.
- Each completed model request logs `summary_completion` with story ID, model, finish reason, truncation flag, configured limit, and available input/output/reasoning token counts. Count `truncated: true` events for truncated attempts and distinct story IDs for affected stories, within the log retention window. Missing usage is null, not zero. The API cannot report how many additional tokens an interrupted generation would have needed.
- Truncation uses the `summary_output_truncated` failure code, visible in `/admin/status`. This status lists current failures, not lifetime totals. Automatic channel failures back off from 10 minutes up to six hours. Unpublished retries still require the story to appear in the current top-30 fetch; dropping off that list can prevent automatic retry. Refresh failures preserve existing published content.
- Generates a short channel overview, cited HN discussion, and a complete Chinese rewrite of the retrieved source in one OpenRouter response. The rewrite preserves the source's reasoning, examples, quantitative evidence, and limitations; HN contributions stay in the channel summary. Unknown image references and an empty rewrite for a readable source are rejected. Legacy stored summaries remain readable without a rewrite. Telegraph content stays below its 64 KB limit.
  Summary and reading-assistant requests attribute usage to `HN Digest` with `HTTP-Referer: https://github.com/luoling8192/hn-digest` and `X-OpenRouter-Title: HN Digest`. New apps are publicly listed by default on OpenRouter.
- Editorial guidance is 150–300 Chinese characters for the channel overview and 80–150 for substantive HN additions, extending to about 200 for a consequential disagreement. These are prompt guidance, not generation guarantees. Message rendering bounds the overview and discussion to 1,400 and 600 UTF-16 code units respectively; the reading page uses the separate rewrite without those message budgets. Citation validation checks supplied IDs, not semantic support; inspect real previews before publication.
- Telegram messages link the title to the source, place the overview and cited HN additions in one expandable quote, then show separate `🔗 原文`, `⏱️ 阅读时间`, and `💬 HN 讨论` rows. Zero to two retrieval tags sit at the bottom. Broad category labels such as `网络` and `产品` are rejected; the model receives canonical historical tags and representative titles. The Chinese Telegraph page is explicitly selected for the native link preview below the text. There is no custom reading URL keyboard; existing text-message edits clear the old keyboard. Native Instant View availability and preview caching remain Telegram client behavior.
- Firecrawl also returns HTML for source figures and captions. The extractor retains an OG cover and up to eight ordered body images with stable IDs, filtering unsafe URLs, obvious tiny images, and navigation/tracking images. Rewrite sections reference those IDs; the reading page renders the cover once and deduplicates figures. Image hosts must remain reachable by Telegram. Existing cached articles without media are not automatically rescraped. Reading pages finish with source/discussion links, generation time, and the AI disclaimer last.
- Refreshes score/comment metadata for 48 hours after publication. Discussion summaries regenerate after at least one hour when comments grow by 10, grow by 20% after the first 10 comments, or remain changed for 12 hours. Updates reuse the original Telegraph page and Telegram message and are capped at three per story.
- Independently retries missing published article sources, up to three per cycle with different hosts prioritized, even after the discussion window expires. Recovery uses persistent backoff from 10 minutes to six hours, caches a retrieved source across summary failures, and updates the original page/message. Failed message edits resume without refetching or resending. Historical reading candidates become eligible for retry after six hours with an oldest-first reserved slot, even when inventory is full; invalid cached sources are retrieved again. Full inventory retries one candidate per hour. Idle backfill waits a minute and logs inventory changes or an hourly heartbeat. Persistent failures continue to consume retrieval attempts at the capped interval.
- The reading estimate describes the source article (220 words or 400 Han characters per minute) and is omitted when the article could not be extracted. A fire marker is shown at 400 points; this is an explicit product rule, not a claim about the reference channel's hidden implementation.

## Railway

The production service is connected to the GitHub repository `luoling8192/hn-digest`, branch `main`. Pushing to `main` triggers Railway deployment using the root Dockerfile. Production secrets remain in Railway Variables; the `/data` volume is retained across deployments.

Deploy the Dockerfile as one persistent service with **one replica** and a volume mounted at `/data`. Set all required variables from `.env.example`. Set the health check path to `/healthz`, use port 3000, and keep `AUTO_PUBLISH=false` until the initial publication is checked. No cron service is necessary; the application owns its scheduler.

The SQLite volume retains drafts, Telegraph paths, Telegram message IDs, retry state, scheduler settings, and a process lease. The deployment archive excludes local secrets, data, and artifacts. Back up the volume through Railway before any destructive maintenance. This repository does not configure a backup schedule.

## Operations

Private recommendations, account binding, historical article backfill, and inventory counters are documented in [the reading assistant guide](docs/reading.md). Enable with `TELEGRAM_OWNER_ID`; the existing channel publisher remains available without it.

In the owner's private chat, send `/status` or `运行状态` for publishing progress, archive counts, recent publications, and current failures. Inline buttons refresh the same panel. This read-only view does not invoke the model or trigger publishing.

`GET /healthz` is public and returns only process health. Every `/admin/*` route requires `Authorization: Bearer <ADMIN_TOKEN>`. Avoid putting this token in URLs.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/admin/status` | Publication IDs, delivery state, article availability/size, source-recovery failures and deadlines, page URLs, sampled comment counts, and last cycle |
| POST | `/admin/preview/:hnId` | Generate and persist a draft without publishing externally; `?regenerate=true` replaces only an unpublished draft with no page |
| POST | `/admin/publish/:hnId` | Publish a saved draft or generate one; an already-published ID is a no-op |
| POST | `/admin/run` | Start one background cycle, even while automatic scheduling is paused |
| POST | `/admin/enable` | Persistently enable automatic publishing |
| POST | `/admin/pause` | Pause future automatic cycles; an active cycle drains normally |

Automatic mode is stored in SQLite once changed through the admin API and then overrides the environment default. API preview is protected because it spends model credits. The published Telegraph page is public; no Telegram invitation token is embedded in it.

## Delivery guarantees and recovery

`candidate_evaluated` records each scanned story's score, rank among returned candidates, and selection or skip reason. `candidates_scanned` records the scan size and configured thresholds. Stories outside the scan are not observed or queued. `article_fetch_started`, `article_fetch_response`, `article_fetch_succeeded`, and `article_fetch_failed` identify the `firecrawl` method, story, HTTP status, content type, duration, extracted size, and failure code as applicable. `article_unavailable` follows when retrieval fails or the URL is invalid. `article_recovery_failed` identifies the failed stage, attempts and next deadline; `/admin/status.articleRecoveries` keeps these separate from delivery failures. Logs do not contain API keys, full URLs, or article text.

Channel and reading summaries retry evidence validation failures once with the rejected output and validator feedback. Article and discussion paragraphs sharing a contiguous passage of 40 characters after punctuation/whitespace normalization are rejected, with instructions to keep comment-derived material only in discussion. This catches copied passages, not arbitrary semantic paraphrases. The correction must pass the same checks; HTTP and network failures do not trigger this correction. `summary_evidence_rejected` logs include the story ID, specific validation reason, and whether the rejected output was already a correction, without logging source material or generated summaries.

Known Telegram rejections return to `ready` and retry with exponential backoff. Network errors or a process interruption during `sendMessage` become `uncertain` and **are not automatically resent**. Telegram Bot API has no client idempotency key, so claiming exactly-once delivery would be inaccurate.

If `/admin/status` reports `uncertain`, first inspect the target channel. Reconcile the SQLite publication with the actual message ID if it exists; only reset it to `ready` after verifying no message was delivered. Stop the worker before manual database repair. No unauthenticated reset endpoint is exposed.

If Telegraph page creation succeeds but the response is lost, a later attempt can leave an orphan Telegraph page; it will not cause a duplicate channel message. If an edit response is lost, the next metadata edit is safe to repeat. Instant View clients may cache a page; edits need client-side readback before claiming immediate refresh.

## Verification

`npm run verify` checks formatting, lint, application and test types, all tests, and a clean production build. `npm run test:coverage` prints built-in Node.js line, branch, and function coverage.

The test suite covers the actual HTTP and SQLite boundaries as well as database reopening, process leases, definite send rejection, ambiguous send outcomes, interrupted delivery, same-page discussion refresh, deleted comments, source references, HTML escaping, private-address blocking, legacy summary compatibility, and non-publishing previews. Live acceptance must additionally verify OpenRouter, Telegraph, the target Telegram channel, and persistence after a Railway restart.

## Architecture

- `src/domain.ts` owns validated story, summary, draft, and delivery contracts, including the legacy persisted summary shape.
- `src/application/` owns publication state transitions and scheduling without importing vendor SDKs.
- `src/adapters/` contains the Hacker News, article extraction, OpenRouter, Telegraph, and Telegram boundaries.
- `src/storage/` owns the backwards-compatible SQLite repository and validates every JSON record on read and write.
- `src/admin-server.ts` is the authenticated operations boundary; `src/server.ts` only composes and starts the service.

Dependencies enter the application service through explicit interfaces. Tests replace those external collaborators at construction time while exercising the real domain and persistence paths.

## Reuse

Uses the official Hacker News, Telegram Bot, and Telegraph HTTP APIs, Firecrawl Scrape, jsdom, Zod, and undici. Public article URLs are sent to Firecrawl for browser rendering and Markdown extraction. Source validation and persistent recovery remain application responsibilities. The earlier `hacker-news-worker` research informed the scope, but its Cloudflare-specific delivery implementation was not copied: Railway persistence and recoverable delivery need different state handling.

See the [Firecrawl evaluation](docs/firecrawl-evaluation.md) for the historical failure cohort, manually verified retrieval results, and remaining quality limits. API success alone does not establish that a page contains usable article text.

See [live acceptance](docs/acceptance.md) for the deployment and verification evidence.

## License

Licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [LICENSE](LICENSE) for the full terms. Third-party dependencies retain their respective licenses.
