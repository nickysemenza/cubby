---
name: log-household-maintenance
description: Log completed or planned household maintenance in Cubby, connect it to the right annual Project and durable Product, and receive inventory only when the user asks. Use when the user reports chores, cleaning, servicing, repair, upkeep, or a durable item encountered while recording that work.
---

<!-- Generated from .agents/skills/log-household-maintenance/SKILL.md by apps/web/generator/claude-plugin.ts — do not edit. -->

The log-household-maintenance playbook lives on the Cubby MCP server so it matches the
deployed app. Call the Cubby connector's `playbook` tool with
`{"action": "get", "name": "log-household-maintenance"}` and follow the returned
instructions. Its relative links are repository paths: read the ones a step
needs with `{"action": "read", "path": "…"}`, passing a link's `#anchor` as
`heading`.

If the Cubby connector is not connected, ask the member to connect it
(`https://cubby.nickysemenza.com/api/mcp`) before continuing.
