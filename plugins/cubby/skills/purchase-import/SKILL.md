---
name: purchase-import
description: Support Cubby purchase imports when learning a vendor, importing an order Email, receipt or vendor export, resolving order Email, reconciling financial settlement, or booking shared-cost repayments.
---

<!-- Generated from .agents/skills/purchase-import/SKILL.md by apps/web/generator/claude-plugin.ts — do not edit. -->

The purchase-import playbook lives on the Cubby MCP server so it matches the
deployed app. Call the Cubby connector's `playbook` tool with
`{"action": "get", "name": "purchase-import"}` and follow the returned
instructions. Its relative links are repository paths: read the ones a step
needs with `{"action": "read", "path": "…"}`, passing a link's `#anchor` as
`heading`.

If the Cubby connector is not connected, ask the member to connect it
(`https://cubby.nickysemenza.com/api/mcp`) before continuing.
