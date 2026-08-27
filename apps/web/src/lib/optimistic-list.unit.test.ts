import { describe, expect, it } from "vitest";
import { patchCachedListItem, patchListItem } from "./optimistic-list";

type Row = { id: string; name: string; acquiredAt: Date | null };

const row = (id: string, name = id): Row => ({ id, name, acquiredAt: null });
const acquire = (item: Row): Row => ({ ...item, acquiredAt: new Date(0) });

describe("patchCachedListItem", () => {
  it("patches the matching row of a plain list page", () => {
    const patched = patchCachedListItem<Row>(
      { items: [row("a"), row("b")], count: 2 },
      "b",
      acquire,
    );
    expect(patched).toEqual({
      items: [row("a"), { ...row("b"), acquiredAt: new Date(0) }],
      count: 2,
    });
  });

  it("patches a list page that names its rows `data`", () => {
    expect(
      patchCachedListItem<Row>({ data: [row("a")] }, "a", acquire),
    ).toEqual({ data: [{ ...row("a"), acquiredAt: new Date(0) }] });
  });

  /**
   * The regression this helper exists for. A tag predicate matches the SSR
   * loader's InfiniteData alongside the plain pages, and the previous patcher
   * read `current.items` unconditionally — `undefined` on `{ pages }`, so
   * `.map` threw and took the whole `onMutate` with it.
   */
  it("recurses into infinite pages instead of throwing on them", () => {
    const cached = {
      pages: [{ items: [row("a")] }, { items: [row("b")] }],
      pageParams: [0, 1],
    };
    expect(() => patchCachedListItem<Row>(cached, "b", acquire)).not.toThrow();
    expect(patchCachedListItem<Row>(cached, "b", acquire)).toEqual({
      pages: [
        { items: [row("a")] },
        { items: [{ ...row("b"), acquiredAt: new Date(0) }] },
      ],
      pageParams: [0, 1],
    });
  });

  it("hands back an entry that holds no list, such as a detail query", () => {
    const detail = row("a");
    expect(patchCachedListItem<Row>(detail, "a", acquire)).toBe(detail);
    expect(patchCachedListItem<Row>(undefined, "a", acquire)).toBeUndefined();
    expect(patchCachedListItem<Row>(null, "a", acquire)).toBeNull();
  });

  it("leaves every non-matching row untouched by identity", () => {
    const keep = row("a");
    const patched = patchCachedListItem<Row>({ items: [keep] }, "zzz", acquire);
    expect((patched as { items: Row[] }).items[0]).toBe(keep);
  });
});

describe("patchListItem", () => {
  it("still serves its exact-key callers", () => {
    expect(patchListItem({ items: [row("a")] }, "a", acquire)).toEqual({
      items: [{ ...row("a"), acquiredAt: new Date(0) }],
    });
  });
});
