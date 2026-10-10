# ADR 0010: Unattended Mail import, interactive Burn-down

Status: Accepted.

Pi keeps the work that needs no browser: interpreting classified Emails into
Purchases, Expenses and Product resolutions, within the existing paid-inference
caps. Everything that needs a browser, a logged-in retailer page or adaptive web
research becomes Burn-down: a member's Claude or Codex session finds work in the
Research queue (existing data-quality checks) and makes ordinary MCP writes that
carry Sources. Pi and Burn-down use the same public MCP tools; the private
research tool family, its independent assessor, the signed Mac browser bridge,
account sync, charge hunts and unattended Product enrichment are deleted, along
with their historical execution tables.

We chose this over continuous unattended enrichment because driving the member's
browser from the server required a relay, a native command executor, pause and
permission states, a second write contract and attention UI that together
outweighed the research they enabled, while Claude and Codex already own a
browser and semantic judgment. The consequence is deliberate: with no caller,
Products keep their gaps and the Research queue grows until the next Burn-down.
Server-side web search for Mail import may return later, limited to logged-out
pages.
