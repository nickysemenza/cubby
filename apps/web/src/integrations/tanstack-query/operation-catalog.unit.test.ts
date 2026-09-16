import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

import { calendarHouseholdRipple } from "./cache-tags";
import { invalidateOperationTags } from "./operation-cache";
import {
  defineOperationDomain,
  isOperationQueryKey,
} from "./operation-catalog";

const calendarContract = defineContract("calendar", {
  range: query({
    input: z.object({ start: z.string() }),
    output: z.object({ items: z.array(z.string()) }),
  }),
  rotateFeed: mutation({
    input: z.object({ household: z.string() }),
    output: z.object({ token: z.string() }),
  }),
});
const calendar = defineOperationDomain(calendarContract, {
  range: { tags: [["calendar", "range"]], cache: "browse" },
  rotateFeed: {
    invalidates: (input) => calendarHouseholdRipple(input.household),
  },
});

describe("operation catalog", () => {
  it("recognizes only complete registered finite operation keys", () => {
    expect(
      isOperationQueryKey(calendar.range.queryKey({ start: "2026-08-25" })),
    ).toBe(true);
    expect(
      isOperationQueryKey([
        "operation",
        "not.registered",
        { input: { start: "2026-08-25" } },
      ]),
    ).toBe(false);
    expect(
      isOperationQueryKey(["operation", "calendar.range", { entity: 4 }]),
    ).toBe(false);
  });

  it("derives stable finite and infinite keys with entity specialization", () => {
    expect(calendar.range.queryKey({ start: "2026-08-25" })).toEqual([
      "operation",
      "calendar.range",
      { input: { start: "2026-08-25" } },
    ]);

    const entityDetail = defineOperationDomain(
      defineContract("entity", {
        detail: query({
          input: z.object({ entity: z.string(), id: z.string() }),
          output: z.object({ id: z.string() }),
        }),
      }),
    ).detail.forEntity("product");
    expect(entityDetail.queryKey({ entity: "product", id: "P1" })).toEqual([
      "operation",
      "entity.detail",
      { entity: "product", input: { entity: "product", id: "P1" } },
    ]);
    expect(
      entityDetail.policy({ entity: "product", id: "P1" }).meta.cacheTags,
    ).toContainEqual(["product"]);
    expect(
      entityDetail.infiniteQueryOptions(
        { entity: "product", id: "P1" },
        {
          initialPageParam: 0,
          pageParamSchema: z.number().int().nonnegative(),
          page: (input, page) => ({ ...input, id: `${input.id}-${page}` }),
          getNextPageParam: () => undefined,
        },
      ).queryKey,
    ).toEqual([
      "operation",
      "entity.detail",
      "infinite",
      { entity: "product", input: { entity: "product", id: "P1" } },
    ]);
  });

  it("uses an explicit adapter, parses output, and retains policy metadata", async () => {
    const adapter = vi.fn(async () => ({ items: ["meal"] }));
    const operation = calendar.range.withTransport(adapter);

    await expect(operation.call({ start: "today" })).resolves.toEqual({
      items: ["meal"],
    });
    expect(adapter).toHaveBeenCalledWith({
      operation: "calendar.range",
      input: { start: "today" },
      signal: undefined,
    });
    expect(operation.queryOptions({ start: "today" })).toMatchObject({
      staleTime: 120_000,
      meta: {
        cacheTags: [["calendar", "range"]],
        cacheProfile: "browse",
      },
    });
  });

  it("computes mutation invalidations and invalidates matching tag prefixes", async () => {
    const tags = calendar.rotateFeed.invalidates({
      household: "home",
    });
    expect(tags).toEqual([["calendar", "home"]]);

    const queryClient = new QueryClient();
    queryClient.setQueryDefaults(["operation", "calendar.range", {}], {
      meta: { cacheTags: [["calendar", "home", "range"]] },
    });
    queryClient.setQueryData(["operation", "calendar.range", {}], ["cached"]);
    await invalidateOperationTags(queryClient, tags);
    expect(
      queryClient.getQueryState(["operation", "calendar.range", {}])
        ?.isInvalidated,
    ).toBe(true);
  });
});
