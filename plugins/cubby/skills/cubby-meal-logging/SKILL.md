---
name: cubby-meal-logging
description: Log a real eating event into Cubby's meal, recipe, ingredient, and nutrition model. Use when the user describes food eaten, asks to log calories/macros, identifies a Product/recipe they ate, or adds another person's portion.
---

<!-- Generated from .agents/skills/cubby-meal-logging/SKILL.md by apps/web/generator/claude-plugin.ts — do not edit. -->

The cubby-meal-logging playbook lives on the Cubby MCP server so it matches the
deployed app. Call the Cubby connector's `playbook` tool with
`{"action": "get", "name": "cubby-meal-logging"}` and follow the returned
instructions. Its relative links are repository paths: read the ones a step
needs with `{"action": "read", "path": "…"}`, passing a link's `#anchor` as
`heading`.

If the Cubby connector is not connected, ask the member to connect it
(`https://cubby.nickysemenza.com/api/mcp`) before continuing.
