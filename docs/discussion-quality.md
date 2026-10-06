# Discussion quality review — 2026-10-06

## Scope

Improve reply coverage, synthesize disagreements with evidence for both sides, and retain consequential author/company responses. Article summaries remain separate and complete. No channel messages, stored publications, or production configuration were changed during evaluation.

## Findings and changes

- Breadth-first collection could spend its budget on top-level comments before reading rebuttals. The collector now interleaves roots and replies after the initial batch, prioritizing newly discovered reply chains. Existing comment, character, concurrency, and scan limits remain bounded; duplicate requests and cycles are excluded.
- The model payload called the HN submitter `author`. It now uses `submitter`, provides sample counts and missing-parent IDs, and explicitly prohibits inventing missing context or inferring an author's identity from submission alone.
- Discussion topics must connect claims, rebuttals, and clarifications, cite both sides, and omit tangents rather than append unsupported claims. Reposted company responses must summarize the explanation, claimed remedy, and uncertainty, with attribution to the repost.
- A first live revision cited the Z.ai statement but reduced it to the existence of a screenshot. That failed the content review. The prompt was tightened to prioritize the substance of consequential responses in an early topic.
- Live DeepSeek calls exposed output-budget exhaustion. Both the old and revised prompts initially failed at the existing 6,000-token cap. A comments-only control spent 5,526 of 6,000 completion tokens reasoning; another spent all 6,000 and returned null content. Null content now produces a clear truncation or empty-content error, never a successful draft.

## Sampling evidence

For reproducible source comparisons, two public Algolia discussion trees were loaded into an in-memory item map and passed to the collector. These compare traversal over the same snapshot; Algolia's sibling order is not proof of current Firebase ranking.

| Story | Old sample / replies / characters | Revised sample / replies / characters |
| --- | --- | --- |
| [ZCode silent upload](https://news.ycombinator.com/item?id=49750694) | 111 / 74 / 42,313 | 111 / 74 / 42,313 |
| [ZCode GLM-5.2](https://news.ycombinator.com/item?id=48753715) | 160 / 103 / 30,233 | 160 / 103 / 29,411 |

The smaller thread already fit completely. The larger thread selected different deeper replies, including comments 48752659, 48755680, 48753002, 48754395, and 48764184. Equal reply counts do not imply identical reply coverage or prove better editorial quality.

Separately, the actual `HackerNewsClient` read the official Firebase API for story 49750694 using a curl-backed HTTP transport: 24 sampled comments, 7 replies, 9,767 characters, 30 requests including the story. This exercised real HN response parsing and traversal with a 24-comment / 12,000-character evaluation budget.

## Generation evidence

The full ZCode comparison used 111 comments and 25,281 characters of extracted article text. Model: `deepseek/deepseek-v4.1-flash`. No article text or comments were fabricated. Credentials stayed in process memory and were not written to artifacts.

The model catalog advertised default high reasoning, support for low effort, and optional reasoning. [OpenRouter documents](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) that reasoning and visible output usually share the total output cap. An initial low-effort revised call finished at 5,121 completion tokens, including 2,953 reasoning tokens; the old prompt with the same low effort still hit 6,000. This was a diagnostic comparison, not a statistical benchmark.

The final prompt was compared with low effort and with optional reasoning disabled, keeping the same full article, 111 comments, and 6,000-token cap. Low effort still truncated. Disabling reasoning completed with `finish_reason=stop`, 3,769 completion tokens, zero reasoning tokens, six article sections, and six discussion sections. Structured-output and existing evidence validation passed. The final implementation therefore requests `reasoning: { enabled: false }`; mandatory-reasoning models require a fresh budget evaluation before switching.

The successful response puts the company response first and covers the indexing/Repo Wiki explanation, claimed data destruction, default-on behavior, claimed fix, planned open sourcing/review, and quota compensation. These are attributed to a comment reposting the statement, not treated as an independent audit. The evidence anchor is [comment 49759039](https://news.ycombinator.com/item?id=49759039). Its affected-user discussion contrasts [a user without local artifacts](https://news.ycombinator.com/item?id=49754017) with [a comment identifying the upload endpoint in the package](https://news.ycombinator.com/item?id=49783981), while attributing both observations.

The successful output remains more verbose than the requested editorial target. One peripheral Ghidra analogy was present in the supplied sample but its own comment ID was not included in the topic citations. This is a known semantic-citation limitation, not evidence that ID validation verifies every clause. The key-response omission was corrected in this sample; broader quality claims require more samples.

## Local validation

- `node --import tsx --test test/hacker-news.test.ts test/openrouter-summarizer.test.ts`: 13 tests passed. Covers nested rebuttals under a saturated top-level queue, budgets, deleted parents/cycles/duplicates, submitter identity, missing context, null/truncated output, unknown references, and bounded evidence repair.
- `npx biome check src/adapters/hacker-news.ts src/adapters/openrouter-summarizer.ts test/hacker-news.test.ts test/openrouter-summarizer.test.ts`: passed.
- `git diff --check`: passed.

## Acceptance boundary

Valid comment IDs do not prove semantic support. Manual review must still check that each cited comment supports its topic, that important responses were not omitted, and that reposted claims are not presented as independently established facts. Bounded sampling cannot guarantee discovery of every author response. These are local changes; deployment and channel refresh are separate steps.

## Release follow-up

At the user's request, the final output ceiling is configurable via `OPENROUTER_MAX_OUTPUT_TOKENS`, defaulting to 12,000. The comparisons above used the earlier 6,000 cap. `summary_completion` records finish reason, model, story ID, limit, and available token usage for every parsed model response, including truncation. `summary_output_truncated` distinguishes current truncation failures from generic errors. Log counts are per attempt and limited by retention; current failure rows are not cumulative totals. Previously generic errors cannot reliably be reclassified as truncation.

A regression test verifies that a truncated channel draft is not published, its failure is recorded, and a later eligible cycle succeeds after the backoff. This does not solve retry eligibility after leaving the top-30 list.

Before release, `npm run verify` passed format, lint, type checking, 53 tests, and the production build. Gitleaks 8.30.1 reported zero findings for all local Git refs and the tracked/new source snapshot. This is a bounded automated scan, not a guarantee of absence of sensitive information or a license/compliance audit. GitHub reported the repository as public with no detected license.
