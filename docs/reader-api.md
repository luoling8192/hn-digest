# Reader API (Shiguang iOS app)

Read-only JSON API on the existing HTTP server (same port as `/healthz`), plus Telegram account linking and synced bookmarks. All routes are under `/api/v1`, return `application/json; charset=utf-8`, need no admin token, and never use cookies. The JSON samples below are generated from the test fixtures (`test/reader-api.test.ts`).

## Conventions

- Errors: `{"error": "<code>"}` with the HTTP status. Codes: `invalid_request`, `invalid_cursor`, `invalid_limit`, `invalid_article_id`, `invalid_json`, `unsupported_media_type`, `payload_too_large`, `unauthorized`, `article_not_found`, `link_expired`, `link_unavailable`, `rate_limited`, `not_found`, `internal_error`.
- Rate limit: per client IP (last `X-Forwarded-For` hop, the Railway proxy), token bucket of 60 burst / 120 per minute for all routes, plus 5 burst / 6 per minute on `POST /link/start`. Exceeding returns `429` with `Retry-After` seconds.
- Cache-Control: article list `public, max-age=30`; article detail `public, max-age=60`; everything else `no-store`.
- Times are ISO 8601 UTC strings. Pagination is cursor based: pass `nextCursor` from the previous response as `cursor`; `nextCursor` is `null` at the end. Cursors are opaque. `limit` defaults to 20, maximum 50.
- Only articles that are published to the channel with a Telegraph page and a retrieved source are exposed. Title-only/unavailable articles and unpublished drafts return 404 / are omitted. Historical reading-library articles (Chinese introduction only, no stored page content) are not part of this API in v1.
- Authenticated routes need `Authorization: Bearer <token>`.

## Articles

### `GET /api/v1/articles?cursor=&limit=`

Newest first by publication time (ties by id descending).

```json
{
  "items": [
    {
      "id": 10,
      "title": "用 SQLite 撑起一个小团队的生产系统",
      "overview": "一个小团队说明为什么单机 SQLite 足以支撑他们的生产负载，以及它的边界。",
      "score": 210,
      "commentCount": 10,
      "readingMinutes": 3,
      "publishedAt": "2026-09-18T08:00:00.000Z",
      "coverImageUrl": "https://example.com/cover.jpg",
      "sourceUrl": "https://example.com/article",
      "hnUrl": "https://news.ycombinator.com/item?id=10",
      "tags": [
        "SQLite",
        "架构"
      ]
    }
  ],
  "nextCursor": null
}
```

Fields: `id` (HN story id, stable), `title` (Chinese), `overview` (Chinese short summary), `score` (HN points), `commentCount`, `readingMinutes` (nullable), `publishedAt`, `coverImageUrl` (nullable), `sourceUrl` (nullable; null for HN text posts), `hnUrl`, `tags` (0–4 retrieval tags).

### `GET /api/v1/articles/:id`

Adds the structured long-form body, the HN discussion summary and the AI disclaimer. `404 article_not_found` if unknown or not readable.

```json
{
  "id": 10,
  "title": "用 SQLite 撑起一个小团队的生产系统",
  "overview": "一个小团队说明为什么单机 SQLite 足以支撑他们的生产负载，以及它的边界。",
  "score": 210,
  "commentCount": 10,
  "readingMinutes": 3,
  "publishedAt": "2026-09-18T08:00:00.000Z",
  "coverImageUrl": "https://example.com/cover.jpg",
  "sourceUrl": "https://example.com/article",
  "hnUrl": "https://news.ycombinator.com/item?id=10",
  "tags": [
    "SQLite",
    "架构"
  ],
  "bodyKind": "rewrite",
  "body": [
    {
      "type": "heading",
      "level": 2,
      "text": "为什么选择 SQLite"
    },
    {
      "type": "paragraph",
      "inlines": [
        {
          "type": "text",
          "text": "团队最初使用 PostgreSQL，但运维成本过高。"
        }
      ]
    },
    {
      "type": "paragraph",
      "inlines": [
        {
          "type": "text",
          "text": "改用 "
        },
        {
          "type": "code",
          "text": "SQLite"
        },
        {
          "type": "text",
          "text": " 后部署只剩一个文件。"
        }
      ]
    },
    {
      "type": "image",
      "url": "https://example.com/figure.png",
      "caption": "图 1：部署结构"
    }
  ],
  "discussion": [
    {
      "heading": null,
      "inlines": [
        {
          "type": "text",
          "text": "有人指出写入并发是 "
        },
        {
          "type": "code",
          "text": "WAL"
        },
        {
          "type": "text",
          "text": " 模式的主要限制。"
        }
      ],
      "citations": [
        {
          "number": 1,
          "commentId": 124,
          "author": "alice",
          "url": "https://news.ycombinator.com/item?id=124"
        }
      ]
    }
  ],
  "generatedAt": "2026-09-18T00:00:00.000Z",
  "aiGenerated": true,
  "disclaimer": "本文为 AI 生成的中文改写，请以原文为准。",
  "pageUrl": "https://telegra.ph/page-10"
}
```

- `bodyKind`: `rewrite` (full Chinese rewrite) or `summary` (older articles only have a condensed summary).
- `body` blocks (render in order). Currently emitted: `heading` (`level` 2), `paragraph`, `image` (`url`, `caption|null`; the cover is not repeated). The contract also reserves `quote` (`inlines`), `list` (`ordered`, `items: Inline[][]`) and `code` (`language|null`, `text`) so the client must render them if they appear; the stored source does not contain them today. Unknown block types must be skipped by the client.
- Inline nodes: `text`, `code` (monospace), and `link` (`text`, `url`) — reserved, not emitted yet.
- `discussion[]`: Chinese summary paragraphs of the HN discussion; `citations[]` link each paragraph to HN comments (`number` is the display marker `[n]`, stable across the article; `author` may be null). Empty array when no usable comments.
- `aiGenerated` is always `true`; show `disclaimer`. `pageUrl` is the Telegraph page.

## Linking a Telegram account

The app generates a random `secret` (32–128 chars of `[A-Za-z0-9_-]`, e.g. 32 random bytes base64url) and keeps it in the Keychain. The code (in the bot URL) alone cannot retrieve a token.

1. `POST /api/v1/link/start` body `{"secret": "..."}` →
   `{"code": "<22 chars, 128-bit>", "botUrl": "https://t.me/<bot>?start=link_<code>", "expiresAt": "..."}`. TTL 10 minutes, single use. Open `botUrl`; the user taps Start in Telegram.
2. The bot handles `/start link_<code>`, binds the sender's Telegram user id and replies `已连接 Shiguang App`. An invalid, expired or already claimed code gets `连接码无效或已过期，请回到 Shiguang App 重新获取。`
3. `POST /api/v1/link/poll` body `{"code": "...", "secret": "..."}` every ~2 s:
   - `200 {"status": "pending"}`
   - `200 {"status": "linked", "token": "shg_..."}` — returned exactly once; the code is then consumed.
   - `410 link_expired` — expired, unknown, already redeemed, or wrong secret.
   - `400 invalid_request` — malformed code/secret.
4. `POST /api/v1/link/revoke` with Bearer token → `{"revoked": true}`; token is dead immediately. `401` if not valid.

The token is long-lived (no expiry) until revoked. Codes, secrets and tokens are stored only as SHA-256 hashes. If `TELEGRAM_BOT_USERNAME` or `TELEGRAM_OWNER_ID` is not configured, link routes return `503 link_unavailable`.

## Bookmarks

Bookmarks are the same data as the bot's `/saved` list and the channel “☆ 收藏” button (`reader.feedback[id].saved` in `reading.sqlite`). Changes made here update the channel save counts (sync marked pending) and appear in the bot, and vice versa. A token only ever reaches its own Telegram user's data.

- `GET /api/v1/bookmarks?cursor=&limit=` → `{"items": [<article summary> + "savedAt"], "nextCursor": ...}`, most recently saved first. Saved articles that are no longer readable are omitted.
- `PUT /api/v1/bookmarks/:articleId` → `{"articleId": 10, "saved": true}`. Idempotent; `404 article_not_found` for unknown/unreadable ids.
- `DELETE /api/v1/bookmarks/:articleId` → `{"articleId": 10, "saved": false}`. Idempotent; works for any id.

All three return `401 unauthorized` without a valid token.

## Configuration

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_USERNAME` | Bot username without `@`, used for `botUrl`. Optional; omitting disables linking (and therefore bookmarks). Requires `TELEGRAM_OWNER_ID` since the bot poller only runs then. |
