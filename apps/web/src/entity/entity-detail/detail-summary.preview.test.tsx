import {
  connectedRecordsInputSchema,
  connectedRecordsOutputSchema,
} from "@cubby/schemas/connected-records";
import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import {
  entityReportManyInput,
  type ReportBlock,
} from "@cubby/schemas/entity-report";
import { shortcode } from "@cubby/schemas/identifiers";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, it } from "vitest";
import { page } from "vitest/browser";

import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";
import { installFeatures } from "~/features/registry";
import { overrideOperationDispatch } from "~/integrations/tanstack-query/operation-call";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import type { DetailRecordOf } from "./detail-record";
import { DetailSummary } from "./detail-summary";

installFeatures();

const rows = [
  "Long synthetic garden storage organizer with removable trays",
  "Synthetic household organizer",
  "Third related record",
].map((title, index) => ({
  entity: "product",
  id: `PRD-4K${7 + index}M`,
  title,
  trailing: "1 purchase",
}));
const blocks: ReportBlock[] = [
  { kind: "records", empty: "No records", rows, totalCount: 3 },
  { kind: "note", text: "Routine explanation remains available on expansion." },
];
const examples = {
  product: (
    <DetailSummary
      entity="product"
      record={fromPartial<DetailRecordOf<"product">>({
        fields: {
          brandId: fieldValueFixture(
            entityFieldEnvelopeSchemas.product.detail.shape.fields.shape[
              "brandId"
            ],
            null,
          ),
        },
        id: shortcode("PRD-4K7M"),
        name: "Synthetic garden organizer",
      })}
    />
  ),
  vendor: (
    <DetailSummary
      entity="vendor"
      record={fromPartial<DetailRecordOf<"vendor">>({
        id: shortcode("VEN-4K7M"),
        name: "Synthetic garden shop",
      })}
    />
  ),
  expense: (
    <DetailSummary
      entity="expense"
      record={fromPartial<DetailRecordOf<"expense">>({
        id: shortcode("EXP-4K7M"),
        name: "Synthetic shipping allocation",

        spendingCategoryAllocations: [
          {
            spendingCategoryId: shortcode("SPC-4K7M"),
            spendingCategoryName: "Synthetic allocated supplies",
            amount: 2,
            incomplete: false,
          },
        ],
        fields: {
          lineKind: fieldValueFixture(
            entityFieldEnvelopeSchemas.expense.detail.shape.fields.shape[
              "lineKind"
            ],
            "shipping",
          ),

          spendingCategoryId: {
            current: {
              assignment: { kind: "inherit" },
              controls: { kind: "readonly", reason: "allocated" },
            },
            result: {
              kind: "live",
              decision: {
                outcome: { kind: "empty", reason: "mixed" },
                provenance: { kind: "allocated" },
              },
            },
            work: { kind: "idle" },
          },
        },
      })}
    />
  ),
  purchase: (
    <DetailSummary
      entity="purchase"
      record={fromPartial<DetailRecordOf<"purchase">>({
        id: shortcode("PUR-4K7M"),
        orderId: "SYNTHETIC-42",
      })}
    />
  ),
};

it.each(["product", "vendor", "purchase", "expense"] as const)(
  "keeps %s summaries compact with readable pills and bounded phone width",
  async (entity) => {
    const harness = createBrowserTestHarness();
    const restore = overrideOperationDispatch(async (operation, input) => {
      if (operation === "entityMedia.displayImages")
        return { ok: true, data: {} };
      if (operation === "entity.monthlyExpenseSpend")
        return {
          ok: true,
          data: Array.from({ length: 12 }, (_, i) => ({
            month: `2026-${String(i + 1).padStart(2, "0")}`,
            cents: i === 9 ? 2100 : 0,
          })),
        };
      if (operation === "entity.connectedRecords")
        return {
          ok: true,
          data: connectedRecordsOutputSchema.parse({
            targetEntity: "product",
            items: rows.slice(0, 2).map((row) => {
              const target = {
                entityKind: "product",
                entityId: row.id,
                label: row.title,
              };
              return {
                target,
                paths: [
                  [
                    {
                      ...connectedRecordsInputSchema.parse(input).source,
                      label: "Synthetic source",
                    },
                    target,
                  ],
                ],
                shortestHops: 1,
              };
            }),
            totalCount: 3,
          }),
        };
      if (operation === "entityReport.getMany")
        return {
          ok: true,
          data: {
            reports: entityReportManyInput.parse(input).slots.map((slot) => ({
              slot,
              report: {
                blocks:
                  slot === "purchase.financial-settlement"
                    ? [
                        ...blocks,
                        {
                          kind: "note",
                          text: "Settlement needs review.",
                          tone: "warning",
                        },
                      ]
                    : blocks,
              },
            })),
          },
        };
      throw new Error(`Unexpected summary operation: ${operation}`);
    });
    try {
      for (const width of [1200, 350]) {
        await page.viewport(width === 1200 ? 1440 : 402, 1000);
        render(
          <div style={{ width }} data-testid="summary-frame">
            {examples[entity]}
          </div>,
          { wrapper: harness.wrapper },
        );
        await screen.findAllByText(
          "Long synthetic garden storage organizer with removable trays",
        );
        await waitFor(() =>
          expect(
            screen.queryAllByText(
              "Routine explanation remains available on expansion.",
            ),
          ).toHaveLength(0),
        );
        expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
        await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
        expect(screen.queryAllByText("Settlement needs review.")).toHaveLength(
          entity === "purchase" ? 1 : 0,
        );
        expect(
          screen
            .queryByText("Settlement needs review.")
            ?.closest("section")
            ?.hasAttribute("hidden") ?? false,
        ).toBe(false);
        expect(
          screen.queryAllByRole("link", {
            name: "Synthetic allocated supplies",
          }),
        ).toHaveLength(entity === "expense" ? 1 : 0);
        const frame = screen.getByTestId("summary-frame");
        expect(frame.scrollWidth).toBeLessThanOrEqual(width);
        expect(frame.getBoundingClientRect().height).toBeLessThan(
          width === 1200 ? 480 : 1600,
        );
        for (const pill of frame.querySelectorAll("[data-entity-pill]"))
          expect(pill.getBoundingClientRect().height).toBeLessThan(30);
        const context = screen.getByRole("button", {
          name: "More context",
        });
        fireEvent.click(context);
        expect(context).toHaveAttribute("aria-expanded", "true");
        expect(frame.querySelectorAll("section[hidden]")).toHaveLength(0);
        cleanup();
      }
    } finally {
      restore();
      cleanup();
      harness.dispose();
    }
  },
);

it("keeps failed contextual reports visible without expanding context", async () => {
  const harness = createBrowserTestHarness();
  const restore = overrideOperationDispatch(async (operation) => {
    if (operation === "entityReport.getMany")
      throw new Error("Synthetic report unavailable");
    if (operation === "entity.connectedRecords")
      return {
        ok: true,
        data: connectedRecordsOutputSchema.parse({
          targetEntity: "product",
          totalCount: 0,
          items: [],
        }),
      };
    if (operation === "entity.monthlyExpenseSpend")
      return { ok: true, data: [] };
    if (operation === "entityMedia.displayImages")
      return { ok: true, data: {} };
    throw new Error(`Unexpected summary operation: ${operation}`);
  });
  try {
    render(examples.purchase, { wrapper: harness.wrapper });
    const error = await screen.findByText("Couldn't load Settlement.");
    expect(error.closest("section")).not.toHaveAttribute("hidden");
  } finally {
    restore();
    cleanup();
    harness.dispose();
  }
});
