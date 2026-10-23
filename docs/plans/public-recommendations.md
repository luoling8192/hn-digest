# Public recommendations with private AI access

## Background

Shiguang readers can save channel articles and manage a private collection. Open recommendations from the existing readable article library to everyone while keeping AI questions, natural-language preferences, and new deep-page generation behind owner-managed grants.

## Constraints

- Public requests must not invoke models, extract remote articles, or generate new Telegraph pages.
- Reuse existing Chinese pages; link to the original when a readable stored article has no generated page.
- Validate private chat identity and exact ownership of every batch callback, including old batches after AI access is revoked.
- Public readers may save, like, request fewer similar articles, undo, request another batch, and open their collection.
- Recommendation allowance: one successful batch per 30 seconds, at most 20 batches per UTC+8 day. Empty lists and rejected sends do not consume it.
- Add persistent per-user and shared request limits. Keep the existing owner-only AI access administration.
- Preserve unrelated worktrees and the main checkout's existing `.auv/` files.

## Requirements

| User path | Acceptance |
| --- | --- |
| New reader requests `/recommend` or 推荐 | Up to five readable existing articles; no paid work |
| Reader interacts with a recommendation | Personal feedback and collection persist; foreign and AI callbacks are rejected |
| Reader reaches a rate or daily limit | Clear retry guidance, no extra batch or allowance consumption |
| Owner enables or revokes AI for a user | Existing private AI path works only while granted; public recommendations remain available |
| New reader discovers the Bot | Welcome/help and command metadata describe only available capabilities |

## Delivery plan

- [x] Implement public recommendation routing, controls and persistent limits.
- [x] Verify personal state, zero paid calls, grants/revocation, quotas and restart behavior (197 tests and local browser fixtures).
- [ ] Prepare a reviewable release and verify the real Bot path after deployment authorization and deployment.
