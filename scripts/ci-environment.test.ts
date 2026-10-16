import assert from "node:assert/strict";
import { test } from "node:test";
import { appleEnvironment, webEnvironment } from "./ci-environment.ts";

test("Linux cannot certify an Apple pass without an observed Mac environment", () => {
  assert.throws(
    () => appleEnvironment("linux", "", () => ""),
    /observed Mac environment/,
  );
});

test("an Apple executor observes its own toolchain rather than trusting a different Mac", () => {
  const actual = appleEnvironment(
    "darwin",
    '{"platform":"darwin","xcode":"old"}',
    (command) => `actual ${command}`,
  );
  assert.match(actual, /actual xcodebuild/);
  assert.doesNotMatch(actual, /"old"/);
});

test("a Linux lookup and its observed Mac use identical native environment evidence", () => {
  const actual = appleEnvironment(
    "darwin",
    "",
    (command) => `actual ${command}`,
  );
  assert.equal(
    appleEnvironment("linux", actual, () => {
      throw new Error("must not execute Xcode on Linux");
    }),
    actual,
  );
});

test("changing toolchains invalidates a native pass", () => {
  const before = appleEnvironment("darwin", "", () => "version A");
  const after = appleEnvironment("darwin", "", () => "version B");
  assert.notEqual(before, after);
});

test("a web pass distinguishes platform, runtime and test environment", () => {
  assert.notEqual(
    webEnvironment({ platform: "linux", node: "26", ci: "true" }),
    webEnvironment({ platform: "darwin", node: "26", ci: "true" }),
  );
  assert.notEqual(
    webEnvironment({ platform: "linux", node: "26", ci: "true" }),
    webEnvironment({ platform: "linux", node: "27", ci: "true" }),
  );
});

test("native pass identity distinguishes warning policy before FFI preparation", async () => {
  const { execFileSync } = await import("node:child_process");
  const command = new URL("./ci-environment.ts", import.meta.url).pathname;
  const key = (warnings: string) =>
    execFileSync(process.execPath, [command, "ffi"], {
      encoding: "utf8",
      env: { ...process.env, CARGO_BUILD_WARNINGS: warnings },
    });
  assert.notEqual(key("warn"), key("deny"));
});
