# Live acceptance — 2026-09-18

## Deployment

- Personal Railway workspace: RainbowBird's Projects.
- Project: https://railway.com/project/1ffd675f-13ed-4d1f-a005-eb50ea299793
- Service: https://hn-digest-production.up.railway.app
- Successful deployment: `35944dd7-02c7-4bb5-96f5-96bd1f93cd9e`.
- Node.js 24 Docker image, one replica, persistent SQLite volume at `/data`.
- OpenRouter model: `google/gemini-2.5-flash`. Key configured in Railway Variables with a $10 total limit, no reset and no expiration. Reaching that limit stops model generation until its budget is changed.

## Verified

- Ten automated tests passed and TypeScript production build passed before deployment.
- Public health check returned 200; unauthenticated admin access returned 401.
- OpenRouter generated valid structured summaries from real article and HN comment data.
- Bend source extraction succeeded on Railway; 159 live comments were included in its discussion summary.
- Telegraph page rendered article sections, four discussion topics, direct source-comment links, sampling information and an update timestamp in Edge.
- Telegram's native macOS client displayed the target channel, published cards, Instant View buttons, original links and comment counts.
- Repeating the publish request returned the same message ID (3) and Telegraph page without duplicating the channel message.
- Railway restart changed the process start time and retained exactly the same publication record.
- Automatic mode was enabled in persistent settings. The first complete cycle published three additional stories, updated four records and reported zero failures.
- A source that could not be fetched was explicitly marked unavailable; its page used only the retrieved discussion rather than inventing article sections.

## Acceptance boundary

The native client's Instant View button was visible, but automated mouse activation failed because the client does not implement the required accessibility action. The underlying Telegraph article and discussion layout were visually verified in Edge. Hourly discussion regeneration was covered by the same-page refresh test; a full hour of live comment growth was not observed during acceptance.

## Published samples

- [Bonsai 2 27B：在9倍更小占用空间内实现近乎无损的压缩](https://t.me/c/3713796083/5) — [Telegraph](https://telegra.ph/Bonsai-2-27B在9倍更小占用空间内实现近乎无损的压缩-09-18)
- [Bend：一种通过证明阻止AI错误并在CPU和GPU上运行的语言](https://t.me/c/3713796083/3) — [Telegraph](https://telegra.ph/Bend一种通过证明阻止AI错误并在CPU和GPU上运行的语言-09-18)
- [OpenAI推出法律专用模型Astra for Law](https://t.me/c/3713796083/4) — [Telegraph](https://telegra.ph/OpenAI推出法律专用模型Astra-for-Law-09-18)
- [Hister：一个用于您访问的页面和您保存的文件的私人搜索引擎](https://t.me/c/3713796083/6) — [Telegraph](https://telegra.ph/Hister一个用于您访问的页面和您保存的文件的私人搜索引擎-09-18)

## Operating policy

Every ten minutes, inspect the first 30 HN top stories and publish previously unseen stories with at least 150 points, at most three per cycle. Refresh metadata for 48 hours. At least 30 additional comments trigger discussion regeneration, no more than once per hour and three times per story. Updates edit the existing page and message. These thresholds are configured product choices, not reverse-engineered guarantees of either reference channel.

Pause with authenticated `POST /admin/pause`, resume with `POST /admin/enable`, and inspect `/admin/status`. Admin credentials are in the ignored local `.env.local`; production credentials are in Railway Variables. No secrets are included in this report.
