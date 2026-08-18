# Domain and server rules

## Production changes

Serialize production schema changes: one owner verifies the migration and no
push overlaps another session. Inspect constraints/data, run relevant checks,
keep deployed and prepared code compatible, and use expand → backfill → deploy
→ cleanup for incompatible work. `db:push` is interactive: cancel ambiguous
rename/drop prompts. It does not diff CHECK constraints or partial-index WHERE
clauses; apply those deliberately and read the resulting schema back.

## Data, layers, and deletion

`Database` is opaque: routers pass it onward, services orchestrate, repos alone
call `getDb`; transactions use `withTransaction`. A service earns existence for
cross-cutting enrichment/compute/rollups, not pass-throughs. Cubby domain
compute belongs in recipebridge/WASM; TypeScript assembles inputs and reshapes
outputs instead of recreating it.

Major entities soft-delete. Use `notDeleted`, including `exists`/`notExists`
subqueries unless an `includes-deleted: <reason>` comment makes the exception
intentional. Removal paths clean `SearchDocument` and `EntityEmbedding` in the
same transaction and propagate dependent staleness. Declare exhaustive,
operation-specific incoming-edge policy from `entity-incoming-edges.ts`; UI
delete previews are advisory and mutations re-check transactionally.

## IDs and runtime traps

Use branded identifier schemas; only use `unsafe*Id` at a genuine string
boundary. UUIDs never enter URLs or MCP—shortcodes do. Resolve codes through
`shortcode-resolver`, mint through `insertWithShortcode`, never reuse them, and
keep `shortcodeSchema` a `ZodString`.

On workerd, wall clocks omit synchronous CPU: use CPU-time/sampling for WASM or
JS hot paths. WASM hot-path tracing stays `trace, skip_all`; a global INFO
subscriber accumulates in reused isolates.

For the helper catalogue and exact edge-case rules, load the relevant heading in
[the preserved root reference](root-rules-reference.md).
