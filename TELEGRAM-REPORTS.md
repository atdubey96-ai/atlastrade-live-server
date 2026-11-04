# Telegram portfolio reports

The existing schedule is unchanged: 09:30, 15:40, 20:10 and 02:00 IST on the existing session days. Existing holiday checks and the single paired private chat are preserved.

Each scheduled delivery contains three purpose-specific reports:

1. Existing market overview and index/chain context.
2. Indian equity holdings: portfolio value, cost, total P&L, session P&L and up to ten positive/negative daily percentage movers, each with rupee contribution. Duplicate holdings are grouped. Unknown prices/previous closes are excluded or labelled partial; source session dates are listed.
3. Saved option positions: signed long/short P&L using the same accounting module as Zenith, daily P&L, recorded realised component, expiry breakdown and up to ten positive/negative daily rupee contributors. Open expired/unpriced contracts are not assigned a zero settlement. Closed records have no invented daily P&L.

`TELEGRAM_REPORT_MODE=combined` combines the logical reports. Otherwise reports are separate. Telegram's message limit can still require multiple numbered messages. No recipient, bot token, provider or polling interval is changed.

The existing service-authenticated `/api/indices?route=holdings` feed now includes only the option-position fields required for accounting. It does not expose broker credentials, orders, notes, cash, security or profile data. Anonymous requests remain rejected. The frontend deployment should be released first; a missing option feed is shown as unavailable rather than no saved positions.

Quotes may be the latest available closed session. In-session delayed option quotes are withheld. These messages describe saved tracking records, not broker settlement or fees.

`option-positions.cjs` is the unchanged copy of Zenith's `shared/option-positions.js`; preserve accounting parity when updating it.

During a transient send error, delivery resumes at the next unsent message within the same running process. Restart-level schedule deduplication is unchanged.
