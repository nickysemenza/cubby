import { describe, expect, it } from "vitest";
import { staticImportSpecifiers } from "./analyze-client-bundle";

describe("client bundle analyzer", () => {
  it("collects static imports and excludes dynamic imports", () => {
    const code = `
      import{a}from"./a.js";
      export{b}from'./b.js';
      import"./side-effect.js";
      const lazy = import("./lazy.js");
    `;

    expect(staticImportSpecifiers(code)).toEqual([
      "./a.js",
      "./b.js",
      "./side-effect.js",
    ]);
  });
});
