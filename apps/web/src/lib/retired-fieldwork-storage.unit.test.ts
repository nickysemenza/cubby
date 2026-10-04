import { describe, expect, it } from "vitest";

import {
  exportRetiredFieldwork,
  findRetiredFieldwork,
  removeRetiredFieldwork,
} from "./retired-fieldwork-storage";

class MemoryStorage {
  private readonly map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

const pass = (overrides: { completed?: string[]; extra?: object } = {}) =>
  JSON.stringify({
    version: 4,
    startedAt: 1_000,
    updatedAt: 2_000,
    currentIndex: 1,
    completed: ["LOC-AAAA"],
    skipped: [],
    totalCount: 3,
    ...overrides,
  });

describe("retired browser-local fieldwork passes", () => {
  it("surfaces unfinished recount and photo-pass work, not other keys", () => {
    const storage = new MemoryStorage();
    storage.setItem("cubby:audit-session:LOC-4K7M", pass());
    storage.setItem("cubby:photo-pass:LOC-4K7M|false|", pass());
    storage.setItem("cubby:shelf-triage:all", pass());
    storage.setItem("theme", "dark");

    const found = findRetiredFieldwork(storage);

    expect(found.map((p) => [p.kind, p.scope])).toEqual([
      ["recount", "LOC-4K7M"],
      ["photo-pass", "LOC-4K7M|false|"],
    ]);
    expect(found[0]).toMatchObject({
      settledCount: 1,
      totalCount: 3,
      updatedAt: 2_000,
    });
  });

  it("counts staged recount decisions as unsaved work even when every stop is settled", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "cubby:audit-session:LOC-4K7M",
      pass({
        completed: ["a", "b", "c"],
        extra: { itemResolutions: [["INV-1", { kind: "remove" }]] },
      }),
    );

    const found = findRetiredFieldwork(storage);

    expect(found).toHaveLength(1);
    expect(found[0]?.stagedCount).toBe(1);
  });

  it("offers nothing for finished or unreadable passes, but still removes them", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "cubby:audit-session:LOC-4K7M",
      pass({ completed: ["a", "b", "c"] }),
    );
    storage.setItem("cubby:photo-pass:house|false|", "not json");

    expect(findRetiredFieldwork(storage)).toEqual([]);

    removeRetiredFieldwork(storage);
    expect(storage.length).toBe(0);
  });

  it("removal leaves unrelated storage alone", () => {
    const storage = new MemoryStorage();
    storage.setItem("cubby:audit-session:LOC-4K7M", pass());
    storage.setItem("cubby:shelf-triage:all", pass());

    removeRetiredFieldwork(storage);

    expect(storage.getItem("cubby:shelf-triage:all")).not.toBeNull();
    expect(storage.getItem("cubby:audit-session:LOC-4K7M")).toBeNull();
  });

  it("exports the raw blobs so nothing is lost on download", () => {
    const storage = new MemoryStorage();
    storage.setItem("cubby:audit-session:LOC-4K7M", pass());

    const exported = JSON.parse(
      exportRetiredFieldwork(findRetiredFieldwork(storage)),
    );

    expect(exported.passes[0]).toMatchObject({
      key: "cubby:audit-session:LOC-4K7M",
      kind: "recount",
      state: { completed: ["LOC-AAAA"], totalCount: 3 },
    });
  });
});
