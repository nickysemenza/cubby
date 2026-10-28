import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { testShortcode } from "@cubby/schemas/testing";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createEditorBrowserTestHarness as createBrowserTestHarness } from "#web/tests/editor-metadata.fixtures.ts";
import {
  entityReadFixture,
  fieldValueFixture,
} from "~/entity/fields/field-envelope.fixtures";
import { useProductCategories } from "~/entity/hooks/use-product-categories";
import { entityRipple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { overrideOperationDispatch } from "~/integrations/tanstack-query/operation-call";

import { CategoryLabelById } from "./category-label";

const rootInput = {
  id: testShortcode("productCategory", "CAT-R222"),
  name: "Workshop",
  parentId: null,
  sortOrder: 0,
  stockTracked: false,
  parentName: null,
  productCount: 0,
  dataQuality: {
    status: "not_assessed",
    score: null,
    facets: [],
    gaps: [],
    exceptions: [],
    relatedGaps: [],
    relatedExceptions: [],
  },
  displayImages: [],
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-01T00:00:00Z"),
  feature: "tools",
  effectiveFeature: "tools",
  aliases: [],
  description: null,
  path: [{ id: "CAT-R222", name: "Workshop" }],
};
const root = entityReadFixture(
  entityFieldEnvelopeSchemas.productCategory.list,
  {
    ...rootInput,
    fields: {
      path: fieldValueFixture(
        entityFieldEnvelopeSchemas.productCategory.list.shape.fields.shape.path,
        rootInput.path,
      ),
      feature: fieldValueFixture(
        entityFieldEnvelopeSchemas.productCategory.list.shape.fields.shape
          .feature,
        "tools",
      ),
      stockTracked: fieldValueFixture(
        entityFieldEnvelopeSchemas.productCategory.list.shape.fields.shape
          .stockTracked,
        false,
      ),
    },
  },
);
const child = {
  ...root,
  id: testShortcode("productCategory", "CAT-C222"),
  name: "Hand tools",
  parentId: root.id,
  feature: null,
  fields: {
    ...root.fields,
    path: fieldValueFixture(
      entityFieldEnvelopeSchemas.productCategory.list.shape.fields.shape.path,
      [...rootInput.path, { id: "CAT-C222", name: "Hand tools" }],
    ),
  },
};

const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const firstPage = Array.from({ length: 500 }, (_, index) => ({
  ...root,
  id:
    index === 0
      ? root.id
      : `CAT-F${alphabet[Math.floor(index / alphabet.length)]}${alphabet[index % alphabet.length]}2`,
}));

function VocabularyConsumer() {
  const { categories, isLoading } = useProductCategories();
  return (
    <output>{isLoading ? "Loading vocabulary" : categories.length}</output>
  );
}

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => harness.dispose());

describe("CategoryLabelById", () => {
  it("falls back to a known record link after an initial vocabulary error", async () => {
    const restore = overrideOperationDispatch(async () => {
      throw new Error("Synthetic vocabulary unavailable");
    });
    try {
      render(<CategoryLabelById id={child.id} name="Known category" />, {
        wrapper: harness.wrapper,
      });
      expect(
        await screen.findByRole("link", { name: "Known category" }),
      ).toHaveAttribute("href", `/product-categories/${child.id}`);
      expect(screen.queryByLabelText("Loading category")).toBeNull();
    } finally {
      restore();
    }
  });

  it("retains a loaded pill during refresh failure and links a completed missing reference", async () => {
    let fail = false;
    const restore = overrideOperationDispatch(async (operation) => {
      if (fail) throw new Error("Synthetic vocabulary refresh failed");
      if (operation === "entity.list")
        return {
          ok: true,
          data: {
            entity: "productCategory",
            items: [root],
            meta: {
              pageIndex: 0,
              pageSize: 500,
              totalCount: 1,
              hasNextPage: false,
            },
          },
        };
      throw new Error(`Unexpected category operation: ${operation}`);
    });
    try {
      render(
        <>
          <CategoryLabelById id={root.id} />
          <CategoryLabelById id={child.id} name="Missing category" />
        </>,
        { wrapper: harness.wrapper },
      );
      expect(
        await screen.findByRole("link", { name: "Workshop" }),
      ).toHaveAttribute("href", `/product-categories/${root.id}`);
      expect(
        await screen.findByRole("link", { name: "Missing category" }),
      ).toHaveAttribute("href", `/product-categories/${child.id}`);
      fail = true;
      await act(async () => {
        await invalidateOperationTags(
          harness.queryClient,
          entityRipple("productCategory"),
        );
      });
      await waitFor(() =>
        expect(
          harness.queryClient
            .getQueryCache()
            .getAll()
            .some((query) => query.state.status === "error"),
        ).toBe(true),
      );
      expect(screen.getByRole("link", { name: "Workshop" })).toHaveAttribute(
        "href",
        `/product-categories/${root.id}`,
      );
      expect(
        screen.getByRole("link", { name: "Missing category" }),
      ).toHaveAttribute("href", `/product-categories/${child.id}`);
    } finally {
      restore();
    }
  });

  it("links an unresolved reference when a later vocabulary page fails", async () => {
    const restore = overrideOperationDispatch(async (operation, input) => {
      if (operation !== "entity.list")
        throw new Error(`Unexpected category operation: ${operation}`);
      const { pagination } = z
        .object({ pagination: z.object({ pageIndex: z.number() }) })
        .parse(input);
      if (pagination.pageIndex > 0)
        throw new Error("Synthetic later vocabulary page failed");
      return {
        ok: true,
        data: {
          entity: "productCategory",
          items: firstPage,
          meta: {
            pageIndex: 0,
            pageSize: 500,
            totalCount: 501,
            hasNextPage: true,
          },
        },
      };
    });
    try {
      render(
        <>
          <CategoryLabelById id={root.id} />
          <CategoryLabelById id={child.id} name="Later category" />
        </>,
        { wrapper: harness.wrapper },
      );
      expect(
        await screen.findByRole("link", { name: "Later category" }),
      ).toHaveAttribute("href", `/product-categories/${child.id}`);
      expect(screen.getByRole("link", { name: "Workshop" })).toHaveAttribute(
        "href",
        `/product-categories/${root.id}`,
      );
      expect(screen.queryByLabelText("Loading category")).toBeNull();
    } finally {
      restore();
    }
  });

  it("shares the projected vocabulary and resolves a later-page inherited feature without tree reads", async () => {
    const operations: string[] = [];
    const pageIndexes: number[] = [];
    const restore = overrideOperationDispatch(async (operation, input) => {
      operations.push(operation);
      if (operation !== "entity.list")
        throw new Error(`Unexpected category operation: ${operation}`);
      const { pagination } = z
        .object({
          pagination: z.object({ pageIndex: z.number() }),
        })
        .parse(input);
      pageIndexes.push(pagination.pageIndex);
      return {
        ok: true,
        data: {
          entity: "productCategory",
          items: pagination.pageIndex === 0 ? firstPage : [child],
          meta: {
            pageIndex: pagination.pageIndex,
            pageSize: 500,
            totalCount: 501,
            hasNextPage: pagination.pageIndex === 0,
          },
        },
      };
    });
    try {
      render(
        <>
          <VocabularyConsumer />
          <CategoryLabelById id={child.id} />
          <CategoryLabelById id={root.id} />
        </>,
        { wrapper: harness.wrapper },
      );
      const link = await screen.findByRole("link", {
        name: "Workshop / Hand tools",
      });
      expect(link).toHaveAttribute("href", `/product-categories/${child.id}`);
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("501"),
      );
      expect(pageIndexes).toEqual([0, 1]);
      expect(operations).toEqual(["entity.list", "entity.list"]);
      // An inherited tools feature must retain the same category icon as its root.
      expect(link.querySelector("svg")?.outerHTML).toBe(
        screen.getByRole("link", { name: "Workshop" }).querySelector("svg")
          ?.outerHTML,
      );
    } finally {
      restore();
    }
  });
});
