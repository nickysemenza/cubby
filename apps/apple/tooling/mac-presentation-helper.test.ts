import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Failure modes: each run gets a new AX executable identity; stale or tampered
// code is reused; changed source/toolchain is ignored; an ad-hoc helper is used.
test("presentation helper keeps a signed path across runs and rebuilds stale bytes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cubby-ax-helper-"));
  try {
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    const log = path.join(root, "calls.jsonl");
    const source = path.join(root, "helper.swift");
    writeFileSync(source, "first source");
    for (const name of ["xcrun", "codesign"])
      writeFileSync(
        path.join(bin, name),
        `#!${process.execPath}\nimport fs from 'node:fs'; const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(name)},...args])+'\\n'); if(args.includes('--version')) console.log('synthetic compiler'); if(args.includes('-o')) fs.writeFileSync(args[args.indexOf('-o')+1], fs.readFileSync(args[1]));`,
        { mode: 0o755 },
      );
    const module = path.join(import.meta.dirname, "mac-presentation-helper.ts");
    const program = `import { ensureMacPresentationHelper } from ${JSON.stringify(module)}; const result=ensureMacPresentationHelper(${JSON.stringify(source)}, ${JSON.stringify(path.join(root, "cache"))}, {selector:'synthetic-signing-key',team:'SYNTH12345'}); console.log(JSON.stringify(result));`;
    const run = () =>
      JSON.parse(
        execFileSync(
          process.execPath,
          ["--input-type=module", "--eval", program],
          {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
            encoding: "utf8",
          },
        ),
      );
    const first = run();
    const second = run();
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(first.binary, second.binary);
    writeFileSync(first.binary, "tampered");
    assert.equal(run().reused, false);
    writeFileSync(source, "new source");
    assert.equal(run().reused, false);
    const calls: string[][] = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      calls.filter((args) => args[0] === "xcrun" && args.includes("-o")).length,
      3,
    );
    const signatures = calls.filter(
      (args) => args[0] === "codesign" && args.includes("--sign"),
    );
    assert.equal(signatures.length, 3);
    assert.ok(
      signatures.every(
        (args) => args.includes("--identifier") && !args.includes("--deep"),
      ),
    );
    assert.ok(
      calls.some(
        (args) =>
          args[0] === "codesign" &&
          args.includes("--verify") &&
          args.some((arg) => arg.includes("subject.OU")),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
