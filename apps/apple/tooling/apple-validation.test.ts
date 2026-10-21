import assert from "node:assert/strict";
import {
  existsSync,
  openSync,
  closeSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Cleanup must be preview-only by default and never traverse outside a checkout
// or remove files that an active build has open.
test("Apple cleanup previews, preserves open build files, and refuses redirected roots", async (t) => {
  if (process.platform !== "darwin")
    return t.skip("Apple cleanup uses macOS lsof");
  const { cleanApple } = await import("./apple.ts");
  const root = mkdtempSync(join(tmpdir(), "apple-clean-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const derived = join(root, "apps/apple/DerivedData");
  mkdirSync(derived, { recursive: true });
  const output = join(derived, "synthetic-output");
  writeFileSync(output, "synthetic build output");
  const source = join(root, "apps/apple/source.swift");
  writeFileSync(source, "// synthetic source");
  cleanApple(root, false);
  assert.ok(existsSync(output));
  const fd = openSync(output, "r");
  try {
    assert.throws(() => cleanApple(root, true), /open files/);
    assert.ok(existsSync(output));
  } finally {
    closeSync(fd);
  }
  cleanApple(root, true);
  assert.ok(!existsSync(derived));
  assert.ok(existsSync(source));
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "synthetic unrelated file");
  symlinkSync(outside, derived);
  assert.throws(() => cleanApple(root, true), /symlink/);
  assert.ok(existsSync(join(outside, "keep")));
});
