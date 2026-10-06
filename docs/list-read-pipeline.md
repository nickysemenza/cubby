# Progressive standard lists

Standard lists use three shared operations: `entity.listBase`, `entity.listEnrichment`, and `entity.listSummary`. Entity declarations own the deferred field groups and their dependencies. Fields outside those groups are core. Generated schemas validate ownership against the canonical complete row, reject dependency cycles, and supply browser and native metadata.

Base reads perform authoritative filtering, ordering, grouping, pagination, and exact counts. Expensive expressions used to select or order rows still run before base results return. Enrichment reads accept public IDs, resolve declared dependencies, and return canonical patches for requested groups. Summaries apply the complete filter population, including ID restrictions, independently of the visible page. Complete readers call the same selectors and loaders and validate the composed canonical result.

The browser list session and native enrichment model maintain separate field readiness. Pending values are not zero, missing images, or healthy quality. Visible columns and structural/provider dependencies determine requested groups. Superseded work is cancelled and responses from earlier generations are discarded. Ready patches preserve row identity and order. A failed combined server enrichment read falls back to the same reader for individual groups so independent fields remain available; healthy batches select their page once. Failed groups can be retried.

MCP `entity_read.list` at the default summary detail publishes only `entitySummaryFields` (`contracts/mcp-projections.ts`), so it runs `listFields`: the base read, one enrichment read of only the groups that own those fields, and the complete-population summary. `resultDetail: "full"` and kinds without a progressive reader run the complete list. Product list readers start the page's USDA batch as soon as its barcodes load, so the external lookup overlaps the remaining enrichment reads instead of following them.

Specialist workflows keep their existing readers. No database migration, persisted aggregate, new cache, telemetry exporter, or connection-policy change is included.

## Timing evidence

Run `pnpm --dir apps/web exec tsx scripts/read-performance.ts --origin <origin> --output <artifact.json>` with `CUBBY_READ_AUTHORIZATION` or `CUBBY_READ_COOKIE` provided privately in the process environment. The default uses 30 samples after a warmup for Product, Recipe, Planting, and Plant. Use `--entities` for other standard lists and `--concurrent` for overlapping navigation. Credentials and response bodies are never written to artifacts.

`--input` supplies the same filters, sort, grouping, and pagination for compared deployments. `--mode complete` uses explicit `resources` paths from that input; resource GET pagination uses `page=1`, whereas the progressive structured input uses `pageIndex=0`. Keep those populations equivalent. `--first-invocation` labels an operator-provided isolated deployment; the harness does not infer platform cold starts from elapsed time. `--caldav` samples OPTIONS and PROPFIND separately, with appropriate CalDAV credentials.

Artifacts report deployed version, authentication mode, first response, decoded usable rows, enrichment completion, and client elapsed time. SQL count, database acquisition, and Worker CPU require matching sampled trace evidence; unavailable values remain null. A decoded-row measurement does not prove browser paint time. Browser and simulator journeys separately validate usable rows during delayed and failed enrichment.

The targets are warm usable lists below 500 ms, with 300 ms a stretch goal. Compare full enrichment separately. Regional and Hyperdrive evidence, including the missing historical SQL-plan baseline, is recorded in [list-read-infrastructure.md](list-read-infrastructure.md). Placement stays unchanged unless isolated repeated comparisons demonstrate gains without regressions or recurring cost. Pre-entry CalDAV delay remains an explicitly unmeasured platform interval.
