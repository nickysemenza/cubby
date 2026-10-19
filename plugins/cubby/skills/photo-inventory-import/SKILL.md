---
name: photo-inventory-import
description: Import household belongings or wardrobe photos into Cubby from a photo_inventory Run, preserving evidence, ownership, locations, and duplicate decisions.
---

<!-- Generated from .agents/skills/photo-inventory-import/SKILL.md by apps/web/generator/claude-plugin.ts — do not edit. -->

The photo-inventory-import playbook lives on the Cubby MCP server so it matches the
deployed app. Call the Cubby connector's `playbook` tool with
`{"action": "get", "name": "photo-inventory-import"}` and follow the returned
instructions. Its relative links are repository paths: read the ones a step
needs with `{"action": "read", "path": "…"}`, passing a link's `#anchor` as
`heading`.

If the Cubby connector is not connected, ask the member to connect it
(`https://cubby.nickysemenza.com/api/mcp`) before continuing.
