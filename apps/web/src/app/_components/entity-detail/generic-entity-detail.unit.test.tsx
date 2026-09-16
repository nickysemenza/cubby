import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { imageWithEntitySchema } from "@cubby/schemas/image";
import { cookbookSummary } from "@cubby/schemas/recipe";
import { testShortcode } from "@cubby/schemas/testing";
import { TIER1_NUTRIENT_KEYS } from "@cubby/usda-schemas";
import { render, screen, within } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import { entityList } from "~/entities/entity-list.functions";
import { entityTimeline } from "~/entities/entity-timeline.functions";
import {
  detailEntities,
  getEntityDetailOutputSchema,
} from "~/entities/generated/entity-details.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";

import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { GenericEntityDetail } from "./generic-entity-detail";

const genericDetailEntities: readonly GenericDetailEntity[] = [
  ...detailEntities,
  "image",
  "cookbook",
];

const pending = { status: "pending", reason: "totals_missing" } as const;
const emptyTotals = {
  cost: pending,
  nutrition: Object.fromEntries(
    TIER1_NUTRIENT_KEYS.map((key) => [key, pending]),
  ),
  macros: {
    calories: pending,
    protein: pending,
    carbs: pending,
    fat: pending,
    partial: false,
  },
};

/**
 * The generator cannot satisfy a few cross-field refinements (external-id
 * slugs, nutrition coverage); those fields are pinned to their empty shapes.
 * `attachments` stays empty so no gallery mounts under jsdom.
 */
const fixtureOverrides = {
  product: { externalIds: [], attachments: [] },
  ingredient: { product: [], attachments: [] },
  inventory: { product: { externalIds: [] }, attachments: [] },
  meal: { recipes: [], totals: emptyTotals, attachments: [] },
  recipe: { totals: emptyTotals, attachments: [] },
  // Candidate rows hydrate product images over the transport; none here.
  wish: { candidates: [], attachments: [] },
} as const;
const NO_ATTACHMENTS = { attachments: [] } as const;

/** A schema-valid detail record for any generic detail entity. */
function recordFor<E extends GenericDetailEntity>(
  entity: E,
): DetailRecordOf<E> {
  const seed = 7;
  const overrides = Object.hasOwn(fixtureOverrides, entity)
    ? // SAFETY: `hasOwn` proves `entity` is one of the override map's keys.
      fixtureOverrides[entity as keyof typeof fixtureOverrides]
    : NO_ATTACHMENTS;
  const schema =
    entity === "image"
      ? imageWithEntitySchema
      : entity === "cookbook"
        ? cookbookSummary
        : // SAFETY: every other generic detail entity is a kernel detail entity.
          getEntityDetailOutputSchema(entity as never);
  // SAFETY: `schema` is the detail output schema of exactly `entity`, and the
  // overrides only pin fields that schema declares; `mock` re-parses the
  // result with that same schema before returning it.
  return mock(schema, {
    seed,
    overrides: overrides as never,
  }) as DetailRecordOf<E>;
}

// Relation tables and timeline sections read through the transport; canned
// empty reads keep the page's structure under test without a server.
const operations = {
  list: {
    list: entityList.list.withTransport(async () => ({
      items: [],
      meta: { pageIndex: 0, pageSize: 50, totalCount: 0, sums: {} },
    })),
  },
  timeline: {
    timeline: entityTimeline.timeline.withTransport(async () => ({
      groups: [],
      stats: [],
      notes: [],
    })),
  },
};

describe("GenericEntityDetail", () => {
  let harness: ReturnType<typeof createBrowserTestHarness>;
  // Slots (relatedness, product summaries) read through the Start transport,
  // which has no server here. Those reads reject ~1s later and the recorder
  // logs a `<< op` failure line; one landing after the worker tears down
  // fails the run. Drop only that line, and give the last reads time to
  // settle before the file ends.
  let errorSpy: ReturnType<typeof vi.spyOn> | undefined;
  beforeAll(() => {
    const original = console.error.bind(console);
    errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        const line = z.string().safeParse(args[0]);
        if (line.success && line.data.startsWith("<< op-")) return;
        original(...args);
      });
  });
  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    errorSpy?.mockRestore();
  });
  beforeEach(() => {
    harness = createBrowserTestHarness();
  });
  afterEach(() => {
    harness.dispose();
  });

  // Table-driven over the manifest: every declared fields/relation/timeline
  // section renders under its declared id and title, so a declaration the
  // page silently drops fails here rather than in the browser. Slot sections
  // are registry-dependent and covered by their own `applies` predicates.
  const cases = genericDetailEntities.flatMap((entity) =>
    entitySummary[entity].detail.sections
      .filter((section) => section.kind !== "slot")
      .map((section) => ({ entity, section })),
  );

  it.each(cases)(
    "$entity renders the declared $section.kind section $section.id",
    ({ entity, section }) => {
      const { container } = render(
        <GenericEntityDetail
          entity={entity}
          record={recordFor(entity)}
          operations={operations}
        />,
        { wrapper: harness.wrapper },
      );
      const element = container.querySelector(`section#${section.id}`);
      if (!(element instanceof HTMLElement))
        throw new Error(`${entity} did not render section ${section.id}`);
      expect(
        within(element).getByRole("heading", { level: 2 }),
      ).toHaveTextContent(section.title ?? "");
    },
  );

  it("links a reference field to its target's detail route", () => {
    const record = recordFor("task");
    // SAFETY: `testShortcode` mints a valid project shortcode.
    const projectId = testShortcode("project", "PRJ-DECK");
    const linked = { ...record, projectId, projectName: "Deck rebuild" };
    render(
      <GenericEntityDetail
        entity="task"
        record={linked}
        operations={operations}
      />,
      {
        wrapper: harness.wrapper,
      },
    );
    expect(screen.getByRole("link", { name: "Deck rebuild" })).toHaveAttribute(
      "href",
      `/projects/${projectId}`,
    );
  });

  it("derives a cohort action exactly for fields a list filter can select on", () => {
    // Manufacturer has a multiselect descriptor on product; model only a
    // text one, so it must not gain a link the list cannot honour exactly.
    const record = recordFor("product");
    const product = {
      ...record,
      manufacturer: "Milwaukee",
      model: "2853-20",
      category: "tools" as const,
      tags: [],
      externalIds: [],
      ingredient: null,
      food: null,
      primaryGtin: null,
      fdc_id: null,
      cookbooks: [],
      growsIngredientId: null,
    };
    render(
      <GenericEntityDetail
        entity="product"
        record={product}
        operations={operations}
      />,
      {
        wrapper: harness.wrapper,
      },
    );
    expect(
      screen.getByRole("link", {
        name: "Show all products with manufacturer Milwaukee",
      }),
    ).toHaveAttribute("href", "/products?manufacturer=Milwaukee");
    expect(
      screen.getByRole("link", {
        name: "Show all products with category tools",
      }),
    ).toHaveAttribute("href", "/products?category=tools");
    expect(
      screen.queryByRole("link", { name: /with model/i }),
    ).not.toBeInTheDocument();
    // The inline editor and the cohort link are siblings, never nested.
    const categoryEdit = screen.getByRole("button", { name: "tools" });
    const categoryFilter = screen.getByRole("link", {
      name: "Show all products with category tools",
    });
    expect(categoryEdit.contains(categoryFilter)).toBe(false);
  });

  it("labels a book barcode as its ISBN and keeps the declared field order", () => {
    const record = recordFor("product");
    const book = {
      ...record,
      primaryGtin: "09780306406157",
      externalIds: [],
      ingredient: null,
      food: null,
      cookbooks: [],
    };
    const { container } = render(
      <GenericEntityDetail
        entity="product"
        record={book}
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByText("ISBN-13")).toBeVisible();
    expect(screen.getByText("9780306406157")).toBeVisible();
    expect(screen.queryByText("UPC", { exact: true })).not.toBeInTheDocument();
    const labels = Array.from(
      container.querySelectorAll(
        "#basic-information .basic-info-ledger .eyebrow",
      ),
      (element) => element.textContent,
    );
    const section = entitySummary.product.detail.sections.find(
      (candidate) => candidate.id === "basic-information",
    );
    const declared = (section?.kind === "fields" ? section.fields : []).map(
      (key) =>
        key === "primaryGtin"
          ? "ISBN-13"
          : (entityFieldModels.product.fields.find((field) => field.key === key)
              ?.label ?? key),
    );
    // Declared order, minus the fields whose value is empty on this record.
    expect(labels).toEqual(declared.filter((label) => labels.includes(label)));
  });
});
