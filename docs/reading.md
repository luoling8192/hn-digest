# Private reading assistant

## Scope

The existing bot also accepts private messages from `TELEGRAM_OWNER_ID`. This is a numeric Telegram user ID configured by the operator, not an editable username or a user-supplied parameter. Other users, forwarded buttons in other chats, and group messages cannot access the reader's profile. The first accepted private interaction creates the profile. The initial interests are architecture, startups, and engineering experience.

The reader gets up to five articles per message. Inline number buttons select articles; selection does not alter preference weights. Save, more-like-this, fewer-like-this, cancel, and undo edit the existing message. Saved articles paginate in place. New recommendations append a new batch. Replying to a previous batch uses that batch's numbering. Unresolvable replies ask for the target batch instead of using the latest one.

Commands: `/start`, `/recommend`, `/saved`, `/preferences`, `/help`. Chinese text and natural-language preference changes are also accepted. Detailed article questions use stored source text. Recommended articles are queued for full Telegraph summaries with separate, cited HN discussion sections (two concurrent jobs, at most ten queued). The list appears immediately; links are updated in place as summaries become ready. “聊聊这篇” reuses or creates that cached page on demand. Neither path publishes to the channel.

## Account and storage

`/data/reading.sqlite` is separate from the existing delivery database. It stores the owner profile, stable recommendation batches, bookmark/opinion state, source text, article metadata, and Telegram polling offset. Both files use the existing `/data` volume and WAL. No existing publication table or schema version is changed.

Feedback is a state per reader/article, not an accumulated click counter. Bookmark weight is +1, explicit opinion is +3 or -3, distributed over the article's topics. Explicit interests are stronger. Undo checks a per-article revision so it does not overwrite a newer action. A rolling 2,000-article exposure history prevents immediate repeats. The ranking combines topic affinity, modest log-scaled HN score, and topic diversity. It excludes disliked, saved, already shown, and title-only articles. Source years and raw HN scores remain visible; scores are not presented as year-normalized popularity.

## Historical library

1. Index up to 100 high-score stories from each of the preceding 60 monthly windows using the public HN Algolia API, requiring at least 150 points. This aims for approximately 6,000 candidates, but records without external article links are excluded, so the actual count is lower.
2. Prioritize architecture, startup and engineering-experience candidates by title keywords and the least-covered topic. Retrieve at most three concurrently. Failed/challenge sources are retained as failed candidates and never promoted based on comments or title alone.
3. Ground a Chinese introduction and reusable topics in retrieved source text, with an explicit readability check. Retain the extracted source, length, reading estimate, and truncation marker. A successful extraction does not guarantee every element of the original website was captured; the prompt sees at most 14,000 source characters.
4. Prepare `READING_ARCHIVE_TARGET` successful historical articles initially (default 300). As articles are shown, replenish toward a cap of 500. Resume automatically after restart using persisted index and candidate status. Transient failed candidates are eligible after seven days.

The archive worker runs within the persistent Railway service. It is independent of private-chat polling and channel publishing. Model requests use the existing OpenRouter key and its configured account budget. Completing the initial target is not proof of recommendation quality. No large backfill completion is claimed until `/admin/reading` reports actual counts.

Deep summaries retain the publisher's evidence validation. Private recommendations allow one corrective model call when citation or discussion-evidence validation fails; a second invalid result remains rejected. Failed pages retain the original article link. Restart resumes unfinished deep pages for the latest recommendation batch without sending another list.

## Operation and verification

Omit `TELEGRAM_OWNER_ID` to disable the private bot and archive worker. No webhook may be registered for the token when long polling is used. Run one service replica with zero deployment overlap. The worker is stopped and drained before its database is closed.

`GET /admin/reading` uses the existing admin authorization and exposes polling freshness, binding status, indexed/readable/parsed/failed counts, per-topic coverage, truncated-source count, and deep-page count. `POST /admin/reading/send` sends one preview batch to the configured owner only.

Incoming updates are serialized. The persisted offset is claimed before side effects to avoid automatically repeating an ambiguous send after a crash. A crash at that boundary can leave an action unanswered; the user can request it again. Button mutations are idempotent states, and a failed message edit can be retried. Raw user messages and credentials are not logged.

The deterministic interaction tests cover identity rejection, five-item lists, selection versus preference changes, repeated bookmarking, revision-aware undo, old-batch replies, saved-list pagination, database reopening, title-only exclusion, polling replay protection, and text-grounded historical import. Live acceptance separately checks Telegram delivery, model behavior, archive counts, and Railway health.
