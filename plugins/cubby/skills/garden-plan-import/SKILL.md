---
name: garden-plan-import
description: Turn a seasonal garden plan document (beds, per-bed per-season plantings, a dated work calendar, a shopping list, a plant index with variety/source/seed-stock, grow/skip verdicts, watering/lessons prose) into Cubby Locations, a season Project, Tasks, Plants, and planned Plantings via the MCP entity tool (create and commands actions). Use when the user supplies a garden plan, seasonal plan, bed plan, or planting plan and wants it imported or ingested into Cubby.
---

<!-- Generated from .agents/skills/garden-plan-import/SKILL.md by apps/web/generator/claude-plugin.ts — do not edit. -->

The garden-plan-import playbook lives on the Cubby MCP server so it matches the
deployed app. Call the Cubby connector's `playbook` tool with
`{"action": "get", "name": "garden-plan-import"}` and follow the returned
instructions. Its relative links are repository paths: read the ones a step
needs with `{"action": "read", "path": "…"}`, passing a link's `#anchor` as
`heading`.

If the Cubby connector is not connected, ask the member to connect it
(`https://cubby.nickysemenza.com/api/mcp`) before continuing.
