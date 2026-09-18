# Codebase rewrite

## Background

HN Digest is already running in Railway and publishes Chinese Hacker News article and discussion summaries to Telegram through Telegraph Instant View pages. The first implementation proved the product flow, but it combines domain data, persistence, orchestration, scheduling, HTTP handling, and vendor APIs in a small set of tightly coupled files.

## Constraints

- Preserve the current Telegram, Telegraph, OpenRouter, Hacker News, and admin API behavior.
- Preserve every existing environment variable and the Docker/Railway entrypoint.
- Read the SQLite database already mounted at `/data` without destructive migration.
- Keep ambiguous Telegram sends non-retryable until an operator reconciles them.
- Keep unpublished previews free of Telegraph and Telegram side effects.
- Do not publish, deploy, or mutate production data as part of the rewrite.

## Known facts

- The production database stores publications as JSON documents in SQLite.
- Persisted summaries exist in both the original and scan-card formats.
- Telegraph page edits are safely repeatable, while Telegram sends are not idempotent.
- The existing public behavior passes 12 tests, TypeScript checking, and a production build.

## Open questions

None. Product thresholds and presentation rules remain unchanged in this rewrite.

## Requirements

| Requirement | Status |
| --- | --- |
| Separate domain contracts from external API schemas | Done |
| Separate application orchestration from vendor clients | Done |
| Validate persisted and remote data at runtime | Done |
| Preserve delivery and restart-recovery semantics | Done |
| Split tests by behavior and add boundary coverage | Done |
| Add deterministic formatting and lint checks | Done |
| Update operational documentation | Done |

## Todo

| Item | Status |
| --- | --- |
| Record and pass the legacy baseline | Done |
| Replace the source layout and domain model | Done |
| Rewrite adapters and SQLite repository | Done |
| Rewrite digest workflow, scheduler, and admin server | Done |
| Replace the test suite and run all checks | Done |
| Review the final diff and compatibility boundary | Done |

## Verification

- The legacy baseline passed 12 tests, TypeScript checking, and a production build before the rewrite.
- The rewritten service passes formatting, lint, strict application-and-test type checking, 25 tests, and a clean production build.
- Built-in Node.js coverage reports 86.29% line coverage overall and 91.89% for the publication service.
- A read-only production check on 2026-09-18 validated all 10 persisted publication records against the new runtime schema. All were published records using the legacy summary shape.
- No deployment, publication, or production database write was performed during the rewrite.
