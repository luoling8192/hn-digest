# Public article feedback counts

Show `♡ 喜欢 N` and `☆ 收藏 N` on channel articles, counting each account's current positive opinion and saved state once. All private and channel feedback paths share the same source of truth. Keep personal callback notifications and remove the separate original-URL line from channel message text; the title links to the original.

## Constraints

- Derive counts from persisted reader state, including historical feedback. Do not accumulate clicks or expose reader identities.
- Mark changed articles pending in the same SQLite transaction as profile updates. Version acknowledgements prevent losing changes during Telegram requests.
- Refresh the canonical published message and explicitly bound dev previews only. Do not change publication identity or generate article content.
- Serialize body and button edits for each message, rendering body counts when the edit executes.
- Acknowledge clicks before background count edits. Retain failed sync tasks across restart, retry with backoff, and drain work before closing stores.
- Preserve unrelated worktrees and the main checkout's existing `.auv/` files.

## Delivery

- [x] Implement persisted aggregate counts and synchronized channel buttons.
- [x] Remove the separate original-URL line and preserve title navigation.
- [x] Verify toggles, private feedback/undo, concurrent requests, failures, restart, priority over backfill and shutdown (234 tests and local browser interaction).
- [ ] Verify layout in browser fixtures, then publish and inspect real dev-channel clicks in Telegram.
