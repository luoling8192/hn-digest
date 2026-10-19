# Firecrawl retrieval evaluation

Evaluated on 2026-10-19 using authenticated Firecrawl Scrape requests through the
article extractor. This is retrieval evidence, not deployment or Telegram delivery
acceptance. No API keys or captured article bodies are included here.

## Results

The original 28-story failure cohort had two articles accepted by the previous
Jina/direct-HTTP extractor. Firecrawl retrieved ten manually verified usable
sources from those same 28 stories (27 unique URLs). The checks ran at different
times, so this is a practical recovery comparison, not a simultaneous controlled
A/B test or an estimate of success across all sites.

The expanded inventory combined the original cohort, 535 accessible publication
pages (528 published and seven with uncertain delivery), and retained logs from
25 deployments. The logs identified 124 story IDs with final `article_unavailable`
events; a failed individual method was not sufficient evidence of overall failure.
The combined inventory contained 134 story IDs and 133 unique URLs.

All 133 URLs were retried, with 135 API requests including two rate-limit retries.
The extractor initially accepted 96 responses; every accepted body was manually
reviewed against its target and inspected for previews, navigation and comments.

| Manual verdict | Story IDs | Unique URLs |
| --- | ---: | ---: |
| Usable target content, sometimes partial | 70 | 70 |
| Target content present, needs further processing | 13 | 13 |
| Wrong page, preview or missing substantive content | 13 | 13 |
| Retrieval rejected or failed | 38 | 37 |

These are results from a selected historical failure cohort. The 134 records are
not all failed tasks in the database: general publication failures include summary
and delivery errors. The reading index reported 30 failed candidates, which can
also represent annotation failures; their current IDs were unavailable through
the aggregate-only status API and the failing SSH/SFTP connection. Coverage beyond
the retained evidence has not been established.

## Quality boundaries

Firecrawl improves recovery while leaving source validation necessary:

- Reject API failures, non-success origin status, insufficient text and recognized
  challenge/subscription gates. Honor `Retry-After` across both extraction callers.
- Remove verified Medium response sections and Reuters post-article recommendations
  without treating ordinary newsletter prompts or references to CAPTCHA as a block.
- Regressions from the captured bodies cover explicit subscriber-only notices,
  paired article-unlock prompts and form-only Chargebee/hCaptcha responses. Offline
  replay rejects five previously accepted unusable responses while retaining all
  70 manually usable sources; this does not increase the usable-source count.
- Some AP results were navigation rather than the target report. Some Bloomberg
  responses had only opening paragraphs without an explicit gate. Other sources
  mixed substantial reader comments, activity feeds or consent UI into the article.
  The current deterministic checks do not reliably identify all of these cases.
- A 45,000-character limit, pagination, image-only posts and interactive collections
  can leave only part of a source. A valid partial capture does not establish that
  an entire book, thread, video or article was retrieved.

No Jina, direct-origin HTTP or archive fallback is used by the new retrieval path.
HN self-text is still read locally. Failed retrieval remains unavailable rather
than being replaced by generated source text.

## Recovery and rollout

Published records missing their source receive an independent persistent recovery
deadline, including beyond the 48-hour discussion refresh window. Recovery reuses
the original Telegraph page and Telegram message. Retrieved text is cached across
summary failures; an interrupted message edit resumes without a new send.

Recovery is limited to three published records per cycle, with host diversity
prioritized and backoff capped at six hours. Reading candidates become eligible
after six hours; full reading inventory processes one retry per hour. Persistent
failures therefore cause ongoing API attempts and can consume credits.

New unpublished stories still come from the existing top-30 scan. This change does
not add a persistent discovery queue for unpublished stories that leave that scan.

`FIRECRAWL_API_KEY` must be configured before deploying this version. Live retrieval
was tested separately; this PR does not establish production recovery, successful
summary generation or live edits to previously published messages.
