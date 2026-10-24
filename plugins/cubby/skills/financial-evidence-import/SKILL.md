---
name: financial-evidence-import
description: Import financial evidence into Cubby from Monarch MCP or Monarch, Mint, Copilot and Apple Card CSV exports. Use for historical backfill, routine transaction sync, source revisions or confirmed withdrawals; order and receipt itemization belongs to purchase-import.
---

<!-- Generated from .agents/skills/financial-evidence-import/SKILL.md by apps/web/generator/claude-plugin.ts — do not edit. -->

The financial-evidence-import playbook lives on the Cubby MCP server so it matches the
deployed app. Call the Cubby connector's `playbook` tool with
`{"action": "get", "name": "financial-evidence-import"}` and follow the returned
instructions. Its relative links are repository paths: read the ones a step
needs with `{"action": "read", "path": "…"}`, passing a link's `#anchor` as
`heading`.

If the Cubby connector is not connected, ask the member to connect it
(`https://cubby.nickysemenza.com/api/mcp`) before continuing.
