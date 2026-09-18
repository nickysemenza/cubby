import type { EntityRef } from "@cubby/schemas/entity";
import {
  type EntityDisplayImagesOutput,
  ID_CHUNK_SIZE,
} from "@cubby/schemas/entity-media";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { entityMedia } from "~/entities/entity-media.functions";

import {
  EntityDisplayImagesProvider,
  type EntityDisplayImagesQueryOptions,
  useEntityDisplayImage,
  useEntityDisplayImages,
} from "./entity-display-images";

const transport =
  vi.fn<(refs: EntityRef[]) => Promise<EntityDisplayImagesOutput>>();
const queryOptions: EntityDisplayImagesQueryOptions =
  entityMedia.displayImages.withTransport(({ input }) =>
    transport(input.refs),
  ).queryOptions;

const clients: QueryClient[] = [];
const createWrapper = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
};

afterEach(() => {
  transport.mockReset();
  for (const client of clients.splice(0)) client.clear();
});

describe("useEntityDisplayImages", () => {
  it("deduplicates, sorts, chunks, and skips refs with seeded results", async () => {
    transport.mockImplementation(async (refs: EntityRef[]) =>
      Object.fromEntries(
        refs.map((ref) => [
          `${ref.entityType}:${ref.entityId}`,
          { url: `https://images.example/${ref.entityId}.jpg` },
        ]),
      ),
    );
    const refs = Array.from(
      { length: ID_CHUNK_SIZE + 3 },
      (_, index): EntityRef => ({
        entityType: index % 2 === 0 ? "product" : "location",
        entityId: `REF-${String(index).padStart(3, "0")}`,
      }),
    ).reverse();
    refs.push(refs[0]!);
    const seededRef = refs[10]!;
    const seededKey = `${seededRef.entityType}:${seededRef.entityId}`;

    const { result } = renderHook(
      () => useEntityDisplayImages(refs, { [seededKey]: null }, queryOptions),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    expect(transport.mock.calls.map(([chunk]) => chunk)).toEqual([
      expect.any(Array),
      expect.any(Array),
    ]);
    const requested = transport.mock.calls.flatMap(([chunk]) =>
      chunk.map((ref) => `${ref.entityType}:${ref.entityId}`),
    );
    expect(transport.mock.calls[0]?.[0]).toHaveLength(ID_CHUNK_SIZE);
    expect(transport.mock.calls[1]?.[0]).toHaveLength(2);
    expect(requested).toEqual([...requested].sort());
    expect(requested).not.toContain(seededKey);
    expect(new Set(requested)).toHaveLength(requested.length);
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(53));
    expect(result.current[seededKey]).toBeNull();
  });

  it("keeps successful chunks when a neighboring chunk fails", async () => {
    transport
      .mockRejectedValueOnce(new Error("first chunk failed"))
      .mockResolvedValueOnce({
        "product:PRD-LAST": { url: "https://images.example/last.jpg" },
      });
    const refs = Array.from(
      { length: ID_CHUNK_SIZE + 1 },
      (_, index): EntityRef => ({
        entityType: "product",
        entityId:
          index === ID_CHUNK_SIZE
            ? "PRD-LAST"
            : `PRD-${String(index).padStart(3, "0")}`,
      }),
    );

    const { result } = renderHook(
      () => useEntityDisplayImages(refs, {}, queryOptions),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current["product:PRD-LAST"]).toEqual({
        url: "https://images.example/last.jpg",
      }),
    );
  });

  it("preserves images from an outer collection owner inside a nested owner", async () => {
    transport.mockImplementation(async (refs) =>
      Object.fromEntries(
        refs.map((ref) => [
          `${ref.entityType}:${ref.entityId}`,
          { url: `https://images.example/${ref.entityId}.jpg` },
        ]),
      ),
    );
    const outerRef: EntityRef = {
      entityType: "product",
      entityId: "PRD-OUTER",
    };
    const innerRef: EntityRef = {
      entityType: "location",
      entityId: "LOC-INNER",
    };
    const QueryWrapper = createWrapper();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryWrapper>
        <EntityDisplayImagesProvider
          refs={[outerRef]}
          queryOptions={queryOptions}
        >
          <EntityDisplayImagesProvider
            refs={[innerRef]}
            queryOptions={queryOptions}
          >
            {children}
          </EntityDisplayImagesProvider>
        </EntityDisplayImagesProvider>
      </QueryWrapper>
    );

    const { result } = renderHook(
      () => ({
        outer: useEntityDisplayImage(outerRef),
        inner: useEntityDisplayImage(innerRef),
      }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.outer?.url).toContain("PRD-OUTER");
      expect(result.current.inner?.url).toContain("LOC-INNER");
    });
  });
});
