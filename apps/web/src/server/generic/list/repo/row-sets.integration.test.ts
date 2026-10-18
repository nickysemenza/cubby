import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ExpenseFilters } from "@cubby/schemas/project";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { buildEntity, type EntityOverrides } from "tooling/factories/build";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { wasm } from "~/lib/wasm";
import { getDb } from "~/server/db/helpers";
import {
  image as imageTable,
  expense as expenseTable,
  expenseAttribution,
  ledgerParty as ledgerPartyTable,
  imageProcessingSubmission,
  photoRunImage,
  run,
} from "~/server/db/schema";
import {
  expenseDerivedMembershipSql,
  prepareExpenseDerivedRead,
} from "~/server/domains/expense/repo/expense-derived-read";
import { resolveExpenseProjectAllocationScope } from "~/server/domains/expense/repo/lookup";
import { scheduleImageProcessingJobs } from "~/server/domains/image-processing/service/image-processing.service";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import {
  computeAttentionItems,
  projectAttentionFilterTypes,
} from "~/server/domains/project/repo/attention";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  entityKernelContextSchema,
  executeEntity,
  executeEntityAs,
} from "~/server/entity-kernel";
import type { EntityKernelEntity } from "~/server/entity-kernel/contracts";
import type { ListFilterValues } from "~/server/generic/list/repo/field-compiler";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { createTestRequestContext } from "~/server/testing/request-context";

/**
 * Plan rows 1–10 (#2607): filters over child rows, shared identifier rows and
 * JSON record arrays compile from declared row sets (`model.rows`). Each
 * equivalence case runs the retired predicate's SQL and the compiled filter
 * over one synthetic fixture and compares row ids. Failure modes:
 * - two filters through one row set match on different rows (an alias's
 *   source from one alias, its external id from another);
 * - No value through a row set misses a record with no rows at all, or
 *   matches one whose sibling filter picked a value;
 * - Exclude drops a record with no rows, or negates the whole same-row group
 *   instead of its own values;
 * - Match all over a row set ignores the sibling conditions;
 * - a row set's `where` narrowing (`source = 'gtin'`) or a soft-deleted row
 *   leaks into the match;
 * - a terminal reference to a hierarchical entity ignores its
 *   "Include sub-…" toggle;
 * - a term expander stops matching a barcode by the digits read off a package.
 */
describe("row-set filters", () => {
  const ctx = withTestDb();
  const page = { pageIndex: 0, pageSize: 100 };
  const sorted = (ids: Iterable<string>) => [...ids].sort();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
  const listed = async (
    entity: EntityKernelEntity,
    filters: ListFilterValues,
  ) =>
    sorted(
      z
        .object({ items: z.array(z.object({ id: z.string() })) })
        .parse(
          await executeEntity(context(), {
            action: "list",
            entity,
            filters,
            pagination: page,
          }),
        )
        .items.map((row) => row.id),
    );
  /** The live rows of `table` the retired predicate's SQL selects. */
  const oracle = async (table: string, condition: SQL) =>
    sorted(
      (
        await getDb(ctx.db).execute<{ shortcode: string }>(
          sql`SELECT "shortcode" FROM ${sql.identifier(table)} WHERE ${condition}`,
        )
      ).rows.map((row) => row.shortcode),
    );
  /** Ids labelled by the filters that listed them, so a failure names its case. */
  const labelled = (filters: ListFilterValues, ids: string[]) => ({
    filters,
    ids,
  });
  const matchesValues = (expression: SQL, values: readonly string[]) =>
    sql`${expression} IN (${sql.join(
      values.map((value) => sql`${value}`),
      sql`, `,
    )})`;

  it("matches account aliases on one alias, cards by exact last four", async () => {
    const account = (
      name: string,
      sourceAliases: {
        source: string;
        alias: string;
        externalAccountId: string | null;
      }[],
      last4s: string[],
    ) =>
      createRepoEntity(ctx, "financialAccount", {
        name,
        sourceAliases,
        cardNumbers: last4s.map((last4, index) => ({
          last4,
          kind: index === 0 ? "primary" : "wallet_token",
          validFrom: null,
          validTo: null,
          note: null,
        })),
      }).then(({ output }) => output.id);
    const both = await account(
      "Row-set both aliases",
      [
        { source: "plaid", alias: "Both P", externalAccountId: "ACME-0042" },
        {
          source: "statement",
          alias: "Both S",
          externalAccountId: "ACME-0099",
        },
      ],
      ["1111", "2222"],
    );
    const statementOnly = await account(
      "Row-set statement alias",
      [
        {
          source: "statement",
          alias: "Statement",
          externalAccountId: "ACME-0042",
        },
      ],
      ["3333"],
    );
    const unnumbered = await account(
      "Row-set unnumbered alias",
      [{ source: "plaid", alias: "Unnumbered", externalAccountId: null }],
      [],
    );
    const bare = await account("Row-set bare account", [], []);
    const accounts = new Set<string>([both, statementOnly, unnumbered, bare]);
    const inFixture = (ids: string[]) => ids.filter((id) => accounts.has(id));
    const aliases = sql`jsonb_array_elements(CASE
      WHEN jsonb_typeof("FinancialAccount"."sourceAliases") = 'array'
      THEN "FinancialAccount"."sourceAliases" ELSE '[]'::jsonb END) alias`;
    const retired = (sources?: string[], externalIds?: string[]) => sql`EXISTS (
      SELECT 1 FROM ${aliases}
      WHERE ${sources ? matchesValues(sql`alias->>${"source"}`, sources) : sql`true`}
        AND ${externalIds ? matchesValues(sql`alias->>'externalAccountId'`, externalIds) : sql`true`})`;
    const cases: [ListFilterValues, SQL][] = [
      [{ source: ["plaid"] }, retired(["plaid"])],
      [{ externalAccountId: ["ACME-0099"] }, retired(undefined, ["ACME-0099"])],
      // The same alias: `both` holds ACME-0042 on its Plaid alias only.
      [
        { source: ["statement"], externalAccountId: ["ACME-0042"] },
        retired(["statement"], ["ACME-0042"]),
      ],
      [
        { source: ["plaid"], externalAccountId: ["ACME-0042"] },
        retired(["plaid"], ["ACME-0042"]),
      ],
      // A card the account presented before, not only its primary.
      [
        { last4: ["2222"] },
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements("FinancialAccount"."cardNumbers") card WHERE card->>'last4' = ${"2222"})`,
      ],
    ];
    for (const [filters, condition] of cases)
      expect(
        labelled(filters, inFixture(await listed("financialAccount", filters))),
      ).toEqual(
        labelled(
          filters,
          inFixture(await oracle("FinancialAccount", condition)),
        ),
      );

    // Generic row-set keys the predicates never offered.
    const expected: [ListFilterValues, string[]][] = [
      // No value: an alias without an id, or no alias at all.
      [{ externalAccountIdPresenceFilter: "none" }, [unnumbered, bare]],
      // A picked sibling needs an alias, so the bare account drops out.
      [
        { source: ["plaid"], externalAccountIdPresenceFilter: "none" },
        [unnumbered],
      ],
      // Exclude negates its own values only; rows with no alias stay.
      [{ sourceExclude: ["plaid"] }, [statementOnly, bare]],
      // Independent of the same-row group: ACME-0099 on any alias drops
      // the account, though it sits beside a Statement alias.
      [
        { source: ["statement"], externalAccountIdExclude: ["ACME-0099"] },
        [statementOnly],
      ],
      // Match all needs one alias per value, each with the sibling source.
      [
        {
          externalAccountId: ["ACME-0042", "ACME-0099"],
          externalAccountIdMatch: "all",
        },
        [both],
      ],
      [
        {
          source: ["statement"],
          externalAccountId: ["ACME-0042", "ACME-0099"],
          externalAccountIdMatch: "all",
        },
        [],
      ],
      [{ last4Exclude: ["1111", "3333"] }, [unnumbered, bare]],
      // Two Match all filters: each value's alias also holds one of the
      // other filter's values, so no alias pairs Statement with ACME-0042.
      [
        {
          source: ["plaid", "statement"],
          sourceMatch: "all",
          externalAccountId: ["ACME-0042", "ACME-0099"],
          externalAccountIdMatch: "all",
        },
        [both],
      ],
      [
        {
          source: ["plaid", "statement"],
          sourceMatch: "all",
          externalAccountId: ["ACME-0042"],
          externalAccountIdMatch: "all",
        },
        [],
      ],
    ];
    for (const [filters, ids] of expected)
      expect(
        labelled(filters, inFixture(await listed("financialAccount", filters))),
      ).toEqual(labelled(filters, sorted(ids)));
  });

  it("matches a transaction's settlement source and id on one live reference", async () => {
    const { output: card } = await createRepoEntity(ctx, "financialAccount", {
      name: "Row-set settlement card",
    });
    const transaction = async (
      refs: { source: string; externalId: string }[],
    ) =>
      (
        await createRepoEntity(ctx, "financialTransaction", {
          accountId: card.id,
          kind: "purchase",
          status: "pending",
          amount: 12,
          sourceRefs: refs,
        })
      ).output.id;
    const split = await transaction([
      { source: "rowset-bank", externalId: "RS-1" },
      { source: "rowset-card", externalId: "RS-2" },
    ]);
    const paired = await transaction([
      { source: "rowset-bank", externalId: "RS-2" },
    ]);
    const unrefd = await transaction([]);
    const fixture = new Set<string>([split, paired, unrefd]);
    const inFixture = (ids: string[]) => ids.filter((id) => fixture.has(id));
    const retired = (sources?: string[], externalIds?: string[]) => sql`EXISTS (
      SELECT 1 FROM "EntityExternalId" fx
      WHERE fx."entityId" = "FinancialTransaction"."id"
        AND fx."kind" = 'settlement_ref' AND fx."deletedAt" IS NULL
        AND ${sources ? matchesValues(sql`fx."source"`, sources) : sql`true`}
        AND ${externalIds ? matchesValues(sql`fx."externalId"`, externalIds) : sql`true`})`;
    const cases: [ListFilterValues, SQL][] = [
      [{ source: ["rowset-bank"] }, retired(["rowset-bank"])],
      [{ externalId: ["RS-2"] }, retired(undefined, ["RS-2"])],
      [
        { source: ["rowset-bank"], externalId: ["RS-2"] },
        retired(["rowset-bank"], ["RS-2"]),
      ],
    ];
    for (const [filters, condition] of cases)
      expect(
        labelled(
          filters,
          inFixture(await listed("financialTransaction", filters)),
        ),
      ).toEqual(
        labelled(
          filters,
          inFixture(await oracle("FinancialTransaction", condition)),
        ),
      );
    expect(
      inFixture(
        await listed("financialTransaction", {
          sourceRefsExclude: ["rowset-card"],
        }),
      ),
    ).toEqual(sorted([paired, unrefd]));
  });

  it("matches an image's import run and target state on one target row", async () => {
    const runCode = async (parentRunId?: string) => {
      const id = await ensureRun(ctx.db, ctx.actor, {
        purpose: "file_import",
        trigger: "manual",
        ...(parentRunId === undefined
          ? {}
          : { parentRunId: z.string().brand<"RunId">().parse(parentRunId) }),
      });
      const [row] = await getDb(ctx.db)
        .select({ id: run.id, shortcode: run.shortcode })
        .from(run)
        .where(eq(run.id, id));
      return row!;
    };
    const parent = await runCode();
    const child = await runCode(parent.id);
    const image = async (name: string) =>
      createUploadedImageRecord(ctx.db, {
        key: `images/${crypto.randomUUID()}.jpg`,
        filename: name,
        contentType: "image/jpeg",
        size: 512,
      });
    const target = (runId: string, imageId: string, state: string) =>
      getDb(ctx.db)
        .insert(photoRunImage)
        .values({
          // SAFETY: both ids come from rows inserted above.
          runId: runId as never,
          imageId: imageId as never,
          state: state as never,
          targetFingerprint: crypto.randomUUID(),
        });
    const parentPending = await image("rowset-parent-pending.jpg");
    const mixed = await image("rowset-mixed.jpg");
    const childPrepared = await image("rowset-child-prepared.jpg");
    const untargeted = await image("rowset-untargeted.jpg");
    await target(parent.id, parentPending.id, "pending");
    // `mixed` is pending in the child run and prepared in the parent.
    await target(child.id, mixed.id, "pending");
    await target(parent.id, mixed.id, "prepared");
    await target(child.id, childPrepared.id, "prepared");
    const fixture = new Set<string>(
      [parentPending, mixed, childPrepared, untargeted].map(
        (row) => row.shortcode,
      ),
    );
    const inFixture = (ids: string[]) => ids.filter((id) => fixture.has(id));
    const parentCode = parseShortcodeFor("run", parent.shortcode);
    const retired = (runIds: readonly string[] | null, states?: string[]) =>
      sql`EXISTS (SELECT 1 FROM "PhotoRunImage" t WHERE t."imageId" = "Image"."id"
        AND ${runIds === null ? sql`true` : inArray(sql`t."runId"`, [...runIds])}
        AND ${states ? matchesValues(sql`t."state"`, states) : sql`true`})`;
    const cases: [ListFilterValues, SQL][] = [
      [{ runId: [parentCode] }, retired([parent.id, child.id])],
      [{ runId: [parentCode], includeSubRuns: false }, retired([parent.id])],
      [
        { runId: [parentCode], targetState: ["prepared"] },
        retired([parent.id, child.id], ["prepared"]),
      ],
      [
        {
          runId: [parentCode],
          includeSubRuns: false,
          targetState: ["pending"],
        },
        retired([parent.id], ["pending"]),
      ],
      [{ targetState: ["pending"] }, retired(null, ["pending"])],
    ];
    for (const [filters, condition] of cases)
      expect(
        labelled(filters, inFixture(await listed("image", filters))),
      ).toEqual(labelled(filters, inFixture(await oracle("Image", condition))));
    expect(
      inFixture(await listed("image", { targetStateExclude: ["prepared"] })),
    ).toEqual(sorted([parentPending.shortcode, untargeted.shortcode]));
    expect(
      inFixture(
        await listed("image", {
          runIdExclude: [parentCode],
          includeSubRuns: false,
        }),
      ),
    ).toEqual(sorted([childPrepared.shortcode, untargeted.shortcode]));
  });

  it("matches an image job by any submission that scheduled it", async () => {
    const scheduled = async (name: string) => {
      const source = await createUploadedImageRecord(ctx.db, {
        key: `images/${crypto.randomUUID()}.jpg`,
        filename: name,
        contentType: "image/jpeg",
        size: 512,
      });
      await getDb(ctx.db)
        .update(imageTable)
        .set({ sha256: "a".repeat(64) })
        .where(eq(imageTable.id, source.id));
      const { jobIds } = await scheduleImageProcessingJobs(ctx.db, {
        id: source.shortcode,
        kinds: ["describe_image"],
        publish: false,
      });
      return jobIds;
    };
    const first = await scheduled("rowset-job-a.jpg");
    const second = await scheduled("rowset-job-b.jpg");
    const submissions = await getDb(ctx.db)
      .select({ publicId: imageProcessingSubmission.publicId })
      .from(imageProcessingSubmission);
    const fixture = await getDb(ctx.db).execute<{ shortcode: string }>(
      sql`SELECT "shortcode" FROM "ImageProcessingJob" WHERE "id" IN (${sql.join(
        [...first, ...second].map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
    const codes = new Set(fixture.rows.map((row) => row.shortcode));
    const inFixture = (ids: string[]) => ids.filter((id) => codes.has(id));
    for (const { publicId } of submissions)
      expect(
        inFixture(await listed("imageJob", { submissionId: [publicId] })),
      ).toEqual(
        inFixture(
          await oracle(
            "ImageProcessingJob",
            sql`"ImageProcessingJob"."id" IN (
              SELECT membership."jobId"
              FROM "ImageProcessingSubmissionJob" membership
              JOIN "ImageProcessingSubmission" submission ON submission.id = membership."submissionId"
              WHERE submission."publicId" = ${publicId})`,
          ),
        ),
      );
  });

  it("matches a product by any barcode and by its identifier sources", async () => {
    const kernel = context();
    const create = async (name: string, data: EntityOverrides<"product">) =>
      (
        await executeEntityAs(kernel, "create", {
          entity: "product",
          data: buildEntity("product", { name, ...data }),
        })
      ).item.id;
    const addId = (
      code: string,
      source: string,
      kind: "gtin_14" | "asin",
      externalId: string,
    ) =>
      executeEntity(kernel, {
        action: "update",
        entity: "product",
        id: parseShortcodeFor("product", code),
        data: {
          externalIds: [
            {
              op: "add",
              key: { source, kind, externalId },
              value: { isPrimary: false },
            },
          ],
        },
      });
    const scanned = await create("Row-set scanned", { upc: "012345678905" });
    await addId(scanned, "gtin", "gtin_14", "00012345678912");
    const listedOnly = await create("Row-set listed", {});
    await addId(listedOnly, "amazon", "asin", "B0ROWSET01");
    const bare = await create("Row-set bare", {});
    const fixture = new Set<string>([scanned, listedOnly, bare]);
    const inFixture = (ids: string[]) => ids.filter((id) => fixture.has(id));

    // The digits read off a package, a secondary barcode, an absent one.
    for (const term of ["2345678905", "0012345678912", "99999999"])
      expect(
        labelled(
          { upcFilter: term },
          inFixture(await listed("product", { upcFilter: term })),
        ),
      ).toEqual(
        labelled(
          { upcFilter: term },
          inFixture(
            await oracle(
              "Product",
              sql`"Product"."deletedAt" IS NULL AND EXISTS (
              SELECT 1 FROM "EntityExternalId" pei
              WHERE pei."entityId" = "Product"."id" AND pei."source" = 'gtin'
                AND pei."deletedAt" IS NULL AND (${sql.join(
                  [...new Set(wasm.product_code_search_terms(term))].map(
                    (candidate) =>
                      sql`pei."externalId" ILIKE ${`%${candidate}%`}`,
                  ),
                  sql` OR `,
                )}))`,
            ),
          ),
        ),
      );

    const anyLive = sql`SELECT pei."entityId" FROM "EntityExternalId" pei WHERE pei."deletedAt" IS NULL`;
    const cases: [ListFilterValues, SQL][] = [
      [
        { externalIdSource: ["amazon"] },
        sql`"Product"."id" IN (${anyLive} AND pei."source" IN ('amazon'))`,
      ],
      [
        { externalIdsPresenceFilter: "none" },
        sql`"Product"."id" NOT IN (${anyLive})`,
      ],
      [
        { externalIdsPresenceFilter: "has" },
        sql`"Product"."id" IN (${anyLive})`,
      ],
      [
        { externalIdSource: ["amazon"], externalIdsPresenceFilter: "none" },
        sql`("Product"."id" IN (${anyLive} AND pei."source" IN ('amazon')) OR "Product"."id" NOT IN (${anyLive}))`,
      ],
      [
        { externalIdsExclude: ["gtin"] },
        sql`NOT COALESCE(("Product"."id" IN (${anyLive} AND pei."source" IN ('gtin'))), false)`,
      ],
    ];
    for (const [filters, condition] of cases)
      expect(
        labelled(filters, inFixture(await listed("product", filters))),
      ).toEqual(
        labelled(filters, inFixture(await oracle("Product", condition))),
      );
  });

  it("matches an expense's allocation filters on one share and its parties through attributions", async () => {
    const project = async (name: string, parentProjectId?: string) =>
      (
        await createRepoEntity(ctx, "project", {
          name,
          ...(parentProjectId === undefined
            ? {}
            : {
                parentProjectId: parseShortcodeFor("project", parentProjectId),
              }),
        })
      ).output.id;
    const parent = await project("Row-set parent project");
    const child = await project("Row-set child project", parent);
    const other = await project("Row-set other project");
    // Spending categories have no repository writer in the factory roster.
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Row-set materials category",
    });
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Row-set allocation vendor",
    });
    const mixed = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-09-20",
    });
    const line = async (name: string, values: EntityOverrides<"expense">) =>
      (
        await createRepoEntity(ctx, "expense", {
          name,
          cost: 50,
          date: "2026-09-20",
          lineKind: "principal",
          costType: "materials",
          trade: null,
          future: false,
          ...values,
        })
      ).output;
    // Two principals, one on the parent project and one unassigned; the fee
    // splits into a share for each.
    const assigned = await line("Row-set assigned principal", {
      projectId: parseShortcodeFor("project", parent),
      purchaseId: mixed.output.id,
      trade: "plumbing",
      spendingCategoryId: parseShortcodeFor(
        "spendingCategory",
        category.shortcode,
      ),
    });
    const unassigned = await line("Row-set unassigned principal", {
      purchaseId: mixed.output.id,
      trade: "electrical",
    });
    const fee = await line("Row-set mixed fee", {
      cost: 0.04,
      lineKind: "fee",
      costType: "services",
      purchaseId: mixed.output.id,
    });
    const childLine = await line("Row-set child project line", {
      projectId: parseShortcodeFor("project", child),
      costType: "tools",
      trade: "other",
    });
    const otherLine = await line("Row-set other project line", {
      projectId: parseShortcodeFor("project", other),
      trade: "plumbing",
    });
    const party = await createRepoEntity(ctx, "ledgerParty", {
      name: "Row-set beneficiary",
      kind: "member",
    });
    const [lineRow] = await getDb(ctx.db)
      .select({ id: expenseTable.id })
      .from(expenseTable)
      .where(eq(expenseTable.shortcode, childLine.id));
    const [partyRow] = await getDb(ctx.db)
      .select({ id: ledgerPartyTable.id })
      .from(ledgerPartyTable)
      .where(eq(ledgerPartyTable.shortcode, party.output.id));
    await getDb(ctx.db).insert(expenseAttribution).values({
      expenseId: lineRow!.id,
      ledgerPartyId: partyRow!.id,
      role: "beneficiary",
      weight: 1,
    });
    const fixture = new Set<string>(
      [assigned, unassigned, fee, childLine, otherLine].map((row) => row.id),
    );
    const inFixture = (ids: string[]) => ids.filter((id) => fixture.has(id));
    /**
     * The retired composition: one membership over the allocation scope. Its
     * trade presence read the line's own column, which changed (below).
     */
    const retired = async (filters: ExpenseFilters) => {
      const scope = await resolveExpenseProjectAllocationScope(ctx.db, filters);
      return and(
        sql`"Expense"."deletedAt" IS NULL`,
        scope === undefined
          ? undefined
          : expenseDerivedMembershipSql(sql`"Expense"."id"`, scope),
      )!;
    };
    const parentCode = parseShortcodeFor("project", parent);
    const childCode = parseShortcodeFor("project", child);
    const categoryCode = parseShortcodeFor(
      "spendingCategory",
      category.shortcode,
    );
    const cases: ExpenseFilters[] = [
      { projectId: [parentCode] },
      { projectId: [parentCode], includeSubProjects: false },
      { projectPresenceFilter: "none" },
      { projectId: [parentCode], projectPresenceFilter: "none" },
      { spendingCategoryId: [categoryCode] },
      { spendingCategoryPresenceFilter: "has" },
      { trade: ["plumbing"] },
      { costType: ["services"] },
      // One share: the fee's parent-project share carries no electrical trade.
      { projectId: [parentCode], trade: ["electrical"] },
      { projectId: [parentCode], costType: ["services"] },
    ];
    for (const filters of cases)
      expect(
        labelled(filters, inFixture(await listed("expense", filters))),
      ).toEqual(
        labelled(
          filters,
          inFixture(await oracle("Expense", await retired(filters))),
        ),
      );
    const partyCode = parseShortcodeFor("ledgerParty", party.output.id);
    expect(
      inFixture(await listed("expense", { ledgerPartyId: [partyCode] })),
    ).toEqual([childLine.id]);
    // Generic row-set keys the predicates never offered.
    const expected: [ListFilterValues, { id: string }[]][] = [
      // A share with no project keeps the unassigned principal.
      [{ projectIdExclude: [parentCode] }, [unassigned, otherLine]],
      [
        { projectIdExclude: [parentCode], includeSubProjects: false },
        [unassigned, childLine, otherLine],
      ],
      [
        { ledgerPartyIdExclude: [partyCode] },
        [assigned, unassigned, fee, otherLine],
      ],
      // The fee's share follows the plumbing principal.
      [{ tradeExclude: ["plumbing"] }, [unassigned, childLine]],
      // Behavior change (plan §8): trade presence reads the shares, not the
      // line's own column, so the untraded fee has the trades its
      // principals give it (it read as no trade before).
      [{ tradePresenceFilter: "none" }, []],
      [
        { tradePresenceFilter: "has" },
        [assigned, unassigned, fee, childLine, otherLine],
      ],
    ];
    for (const [filters, rows] of expected)
      expect(
        labelled(filters, inFixture(await listed("expense", filters))),
      ).toEqual(labelled(filters, sorted(rows.map((row) => row.id))));
    // Analytics select the same expenses as the list, though they apportion
    // share amounts by their own scope: Match all and same-share trade
    // presence included.
    for (const filters of [
      { projectId: [parentCode, childCode], projectIdMatch: "all" },
      {
        projectId: [parentCode],
        includeSubProjects: false,
        tradePresenceFilter: "has",
      },
      { projectIdExclude: [parentCode] },
    ] satisfies ExpenseFilters[]) {
      const { where } = await prepareExpenseDerivedRead(ctx.db, filters);
      expect(
        labelled(filters, inFixture(await oracle("Expense", where!))),
      ).toEqual(labelled(filters, inFixture(await listed("expense", filters))));
    }
  });

  it("matches a project's attention through its prepared attention items", async () => {
    const project = async (name: string, costEstimate: number | null) => {
      const { output } = await createRepoEntity(ctx, "project", {
        name,
        costEstimate,
      });
      await createRepoEntity(ctx, "expense", {
        name: `${name} spend`,
        projectId: parseShortcodeFor("project", output.id),
        cost: 20,
        date: "2026-09-20",
        future: false,
        lineKind: "principal",
        costType: "materials",
        trade: "other",
      });
      return output.id;
    };
    const unbudgeted = await project("Row-set unbudgeted project", null);
    const budgeted = await project("Row-set budgeted project", 500);
    const fixture = new Set<string>([unbudgeted, budgeted]);
    const inFixture = (ids: string[]) => ids.filter((id) => fixture.has(id));
    // The retired predicate: the attention items of the picked rules.
    const items = await computeAttentionItems(ctx.db);
    const retired = (filter: keyof typeof projectAttentionFilterTypes) =>
      sorted(
        items
          .filter((item) => item.type === projectAttentionFilterTypes[filter])
          .map((item) => item.entityId),
      );
    for (const filter of ["missing_budget", "stalled"] as const)
      expect(
        labelled(
          { attention: [filter] },
          inFixture(await listed("project", { attention: [filter] })),
        ),
      ).toEqual(labelled({ attention: [filter] }, inFixture(retired(filter))));
    expect(
      inFixture(
        await listed("project", { attentionExclude: ["missing_budget"] }),
      ),
    ).toEqual([budgeted]);
    expect(
      inFixture(await listed("project", { attentionPresenceFilter: "none" })),
    ).toEqual([budgeted]);
  });
});
