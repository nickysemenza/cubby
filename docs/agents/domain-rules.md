# Domain and server rules

## Production changes

Serialize production schema changes: one owner verifies the migration and no
push overlaps another session. Inspect constraints/data, run relevant checks,
keep deployed and prepared code compatible, and use expand → backfill → deploy
→ cleanup for incompatible work. `db:push` is interactive: cancel ambiguous
rename/drop prompts. It does not diff CHECK constraints or partial-index WHERE
clauses; apply those deliberately and read the resulting schema back. Before a
`DROP COLUMN`, remove the `schema.ts` declaration and DEPLOY first — the
relational query builder selects every declared column, so the declaration is
the read (see agent validation reference).

## Data, layers, and deletion

`Database` is a request-scoped handle: routers pass it onward, services
orchestrate, and repos alone call `getDb`; transactions use `withTransaction`.
The repository helper is the sanctioned client-resolution boundary. A service earns existence for
cross-cutting enrichment/compute/rollups, not pass-throughs. Cubby domain
compute belongs in recipebridge/WASM; TypeScript assembles inputs and reshapes
outputs instead of recreating it.

Major entities soft-delete. Use `notDeleted`, including `exists`/`notExists`
subqueries unless an `includes-deleted: <reason>` comment makes the exception
intentional. Removal paths clean `SearchDocument` and `EntityEmbedding` in the
same transaction and propagate dependent staleness. Declare exhaustive,
operation-specific incoming-edge policy from `entity-incoming-edges.ts`.
Deletes and merges have no live preview — attempt the mutation and read its
structured refusal. Attach/detach previews stay advisory, and mutations
re-check transactionally regardless.

## IDs and runtime traps

Use branded identifier schemas and parse strings once at genuine ingress seams
(auth, persisted JSON, external input, DOM events, imports, and raw SQL). Typed
producers and resolvers return branded values directly; never reconstruct a
brand with an assertion or unsafe converter. Tests use the deterministic
schema-backed factories from `@cubby/schemas/testing`. UUIDs never enter URLs or
MCP—shortcodes do. Resolve codes through `shortcode-resolver`, mint through
`insertWithShortcode`, never reuse them, and keep `shortcodeSchema` a
`ZodString`.

On workerd, wall clocks omit synchronous CPU: use CPU-time/sampling for WASM or
JS hot paths. WASM hot-path tracing stays `trace, skip_all`; a global INFO
subscriber accumulates in reused isolates.

## Generated files

TS generated output lives in a `generated/` directory and carries a `.gen.`
suffix; Swift/Rust output lives in a `Generated/` directory instead.
`.gitattributes` marks these paths `linguist-generated`. Never hand-edit one —
edit its generator or input and regenerate; a missing one at its expected path
means stub it, not fabricate the real shape.

For the helper catalogue and exact edge-case rules, load the relevant heading in
[the preserved root reference](root-rules-reference.md).
