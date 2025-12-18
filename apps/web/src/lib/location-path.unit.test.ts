import { describe, it, expect } from "vitest";
import {
  buildLocationPath,
  normalizeLocationPath,
  parseLocationPathWithTypes,
  parseLocationPathWithContext,
  type LocationTypeContext,
} from "./location-path";

describe("buildLocationPath", () => {
  it("should build path from single location without brackets when type is default", () => {
    // Root defaults to "room", so no brackets needed
    const location = { name: "Kitchen", type: "room", parent: null };
    expect(buildLocationPath(location)).toBe("Kitchen");
  });

  it("should build path with brackets when root type is non-default", () => {
    // Root is "cabinet" instead of default "room"
    const location = { name: "Kitchen", type: "cabinet", parent: null };
    expect(buildLocationPath(location)).toBe("Kitchen[cabinet]");
  });

  it("should build path without brackets when all types are default", () => {
    // Root=room (default), child=shelf (default)
    const location = {
      name: "Pantry",
      type: "shelf",
      parent: { name: "Kitchen", type: "room", parent: null },
    };
    expect(buildLocationPath(location)).toBe("Kitchen > Pantry");
  });

  it("should build path with brackets only where needed", () => {
    // Root=room (default, no bracket), child=cabinet (non-default, needs bracket)
    const location = {
      name: "Pantry",
      type: "cabinet",
      parent: { name: "Kitchen", type: "room", parent: null },
    };
    expect(buildLocationPath(location)).toBe("Kitchen > Pantry[cabinet]");
  });

  it("should build path with deep nesting and minimal brackets", () => {
    // Garage=room (default), Shelf 1=shelf (default), Bin A=crate (non-default)
    const location = {
      name: "Bin A",
      type: "crate",
      parent: {
        name: "Shelf 1",
        type: "shelf",
        parent: {
          name: "Garage",
          type: "room",
          parent: null,
        },
      },
    };
    expect(buildLocationPath(location)).toBe("Garage > Shelf 1 > Bin A[crate]");
  });

  it("should use custom separator", () => {
    const location = {
      name: "Pantry",
      type: "shelf",
      parent: { name: "Kitchen", type: "room", parent: null },
    };
    expect(buildLocationPath(location, " / ")).toBe("Kitchen / Pantry");
  });

  it("should handle all non-default types requiring brackets", () => {
    // Root=cabinet (non-default), child=crate (non-default)
    const location = {
      name: "Bin",
      type: "crate",
      parent: { name: "Storage", type: "cabinet", parent: null },
    };
    expect(buildLocationPath(location)).toBe("Storage[cabinet] > Bin[crate]");
  });
});

describe("normalizeLocationPath", () => {
  it("should strip brackets from typed path", () => {
    expect(normalizeLocationPath("Kitchen[room] > Pantry[shelf]")).toBe(
      "kitchen > pantry",
    );
  });

  it("should handle path without brackets", () => {
    expect(normalizeLocationPath("Kitchen > Pantry")).toBe("kitchen > pantry");
  });

  it("should handle mixed paths", () => {
    expect(normalizeLocationPath("Kitchen[room] > Pantry")).toBe(
      "kitchen > pantry",
    );
  });

  it("should handle single segment", () => {
    expect(normalizeLocationPath("Kitchen[room]")).toBe("kitchen");
    expect(normalizeLocationPath("Kitchen")).toBe("kitchen");
  });

  it("should trim whitespace", () => {
    expect(normalizeLocationPath("  Kitchen[room]  >  Pantry[shelf]  ")).toBe(
      "kitchen > pantry",
    );
  });

  it("should handle deep nesting", () => {
    expect(
      normalizeLocationPath(
        "Garage[room] > Chrome Shelf[shelf] > Bin A[half-crate]",
      ),
    ).toBe("garage > chrome shelf > bin a");
  });
});

describe("parseLocationPathWithTypes", () => {
  it("should parse typed path", () => {
    expect(parseLocationPathWithTypes("Kitchen[room] > Pantry[shelf]")).toEqual(
      [
        { name: "Kitchen", type: "room" },
        { name: "Pantry", type: "shelf" },
      ],
    );
  });

  it("should use defaults for untyped path (root=room, children=shelf)", () => {
    expect(parseLocationPathWithTypes("Kitchen > Pantry")).toEqual([
      { name: "Kitchen", type: "room" },
      { name: "Pantry", type: "shelf" },
    ]);
  });

  it("should handle mixed typed/untyped", () => {
    expect(parseLocationPathWithTypes("Kitchen[room] > Pantry")).toEqual([
      { name: "Kitchen", type: "room" },
      { name: "Pantry", type: "shelf" },
    ]);
  });

  it("should handle single segment", () => {
    expect(parseLocationPathWithTypes("Kitchen[room]")).toEqual([
      { name: "Kitchen", type: "room" },
    ]);
    expect(parseLocationPathWithTypes("Kitchen")).toEqual([
      { name: "Kitchen", type: "room" },
    ]);
  });

  it("should handle all valid location types", () => {
    // Valid types: room, bag, shelf, crate, half-crate, table, drawer, cart, cabinet
    expect(
      parseLocationPathWithTypes(
        "Room[room] > Cabinet[cabinet] > Shelf[shelf] > Crate[crate] > HalfCrate[half-crate] > Table[table] > Drawer[drawer] > Cart[cart] > Bag[bag]",
      ),
    ).toEqual([
      { name: "Room", type: "room" },
      { name: "Cabinet", type: "cabinet" },
      { name: "Shelf", type: "shelf" },
      { name: "Crate", type: "crate" },
      { name: "HalfCrate", type: "half-crate" },
      { name: "Table", type: "table" },
      { name: "Drawer", type: "drawer" },
      { name: "Cart", type: "cart" },
      { name: "Bag", type: "bag" },
    ]);
  });

  it("should fallback to default for invalid type", () => {
    // Invalid type should fall back to default (shelf for non-root)
    expect(parseLocationPathWithTypes("Kitchen[invalid] > Pantry")).toEqual([
      { name: "Kitchen[invalid]", type: "room" },
      { name: "Pantry", type: "shelf" },
    ]);
  });
});

describe("parseLocationPathWithContext", () => {
  const emptyContext: LocationTypeContext = {
    pathTypes: new Map(),
    existingTypes: new Map(),
    conflicts: [],
  };

  it("should use explicit bracket notation first", () => {
    const context: LocationTypeContext = {
      pathTypes: new Map([["kitchen", "cabinet"]]), // Different type in context
      existingTypes: new Map(),
      conflicts: [],
    };

    expect(parseLocationPathWithContext("Kitchen[room]", context)).toEqual([
      { name: "Kitchen", type: "room" },
    ]);
  });

  it("should use CSV context when no bracket notation", () => {
    const context: LocationTypeContext = {
      pathTypes: new Map([["kitchen", "cabinet"]]),
      existingTypes: new Map(),
      conflicts: [],
    };

    expect(parseLocationPathWithContext("Kitchen", context)).toEqual([
      { name: "Kitchen", type: "cabinet" },
    ]);
  });

  it("should use DB context when no bracket or CSV context", () => {
    const context: LocationTypeContext = {
      pathTypes: new Map(),
      existingTypes: new Map([["kitchen", "cabinet"]]),
      conflicts: [],
    };

    expect(parseLocationPathWithContext("Kitchen", context)).toEqual([
      { name: "Kitchen", type: "cabinet" },
    ]);
  });

  it("should fall back to defaults when no context", () => {
    expect(
      parseLocationPathWithContext("Kitchen > Pantry", emptyContext),
    ).toEqual([
      { name: "Kitchen", type: "room" },
      { name: "Pantry", type: "shelf" },
    ]);
  });

  it("should handle multi-level path with mixed context", () => {
    const context: LocationTypeContext = {
      pathTypes: new Map([["kitchen > pantry", "crate"]]), // Full path key
      existingTypes: new Map([["kitchen", "room"]]),
      conflicts: [],
    };

    expect(parseLocationPathWithContext("Kitchen > Pantry", context)).toEqual([
      { name: "Kitchen", type: "room" },
      { name: "Pantry", type: "crate" },
    ]);
  });
});
