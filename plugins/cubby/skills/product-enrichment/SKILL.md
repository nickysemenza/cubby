---
name: product-enrichment
description: Burn down Cubby's Research queue - enrich Products with verified identity facts, Sources and representative cover images using your own browser. Use for missing product metadata/images, specific Products from purchase import, or source-backed corrections.
---

<!-- Generated from .agents/skills/product-enrichment/SKILL.md by apps/web/generator/claude-plugin.ts — do not edit. -->

The product-enrichment playbook lives on the Cubby MCP server so it matches the
deployed app. Call the Cubby connector's `playbook` tool with
`{"action": "get", "name": "product-enrichment"}` and follow the returned
instructions. Its relative links are repository paths: read the ones a step
needs with `{"action": "read", "path": "…"}`, passing a link's `#anchor` as
`heading`.

If the Cubby connector is not connected, ask the member to connect it
(`https://cubby.nickysemenza.com/api/mcp`) before continuing.
