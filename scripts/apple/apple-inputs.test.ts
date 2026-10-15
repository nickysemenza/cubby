import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { appleGeneratedDigest } from "./apple-inputs.ts";

test("Apple hashes declared outputs, isolates app fixtures, and rejects missing inputs", (t) => {
  const root = mkdtempSync(join(tmpdir(), "apple-inputs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const kit = "apps/apple/CubbyKit/Sources/CubbyKit/Generated/Example.swift";
  const app = "apps/apple/Generated/PreviewFixtures/example.json";
  const manifest = "apps/web/src/lib/generated/artifacts.gen.json";
  const write = (file: string, value: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), value);
  };
  write(manifest, JSON.stringify([kit, app]));
  write(kit, "struct Example {}\n");
  write(app, '{"name":"Example"}');
  const host = appleGeneratedDigest(root, "host");
  const simulator = appleGeneratedDigest(root, "app");
  write(app, '{"name":"Changed"}');
  assert.equal(appleGeneratedDigest(root, "host"), host);
  assert.notEqual(appleGeneratedDigest(root, "app"), simulator);
  write("apps/apple/CubbyKit/Sources/.DS_Store", "local noise");
  assert.equal(appleGeneratedDigest(root, "host"), host);
  write(kit, "struct Changed {}\n");
  assert.notEqual(appleGeneratedDigest(root, "host"), host);
  rmSync(join(root, kit));
  assert.throws(() => appleGeneratedDigest(root, "host"), /ENOENT/);
  write(manifest, "[]");
  assert.throws(() => appleGeneratedDigest(root, "host"), /No generated Apple/);
});
