import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { measureServerClosure } from "./check-server-closure";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function dist(files: Record<string, string>) {
  root = mkdtempSync(path.join(tmpdir(), "server-closure-"));
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), source);
  }
  return root;
}

describe("measureServerClosure", () => {
  it("counts the request path through the server entry and router chunk, not other lazy chunks", () => {
    const report = measureServerClosure(
      dist({
        "index.js":
          'import{a}from"./assets/db-1.js";const s=()=>import(`./assets/server-1.js`);',
        "assets/db-1.js": "export const a=1;",
        "assets/server-1.js": 'const r=()=>import("./router-1.js");',
        "assets/router-1.js":
          'import"./auth-1.js";const o=()=>import(`./openapi-1.js`);',
        "assets/auth-1.js": "x".repeat(100),
        "assets/openapi-1.js": "y".repeat(1000),
      }),
    );
    expect(report.firstRequest.files.sort()).toEqual([
      "assets/auth-1.js",
      "assets/db-1.js",
      "assets/router-1.js",
      "assets/server-1.js",
      "index.js",
    ]);
    expect(report.total.files).toContain("assets/openapi-1.js");
  });

  it("names the import chain that pulls a chunk onto the request path", () => {
    const report = measureServerClosure(
      dist({
        "index.js": "const s=()=>import(`./assets/server-1.js`);",
        "assets/server-1.js": "const r=()=>import(`./router-1.js`);",
        "assets/router-1.js": 'import{x}from"./run-service-1.js";',
        "assets/run-service-1.js": 'import"./ai-sdk-1.js";',
        "assets/ai-sdk-1.js": "z".repeat(500),
      }),
    );
    expect(report.chainTo("assets/ai-sdk-1.js")).toEqual([
      "index.js",
      "assets/server-1.js",
      "assets/router-1.js",
      "assets/run-service-1.js",
      "assets/ai-sdk-1.js",
    ]);
  });
});
