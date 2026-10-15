import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installedApprovalVerifier } from "./lib/mac-app-approval.ts";

// A valid same-team signature may still fail the requirement stored by TCC.
// codesign emits display output on stderr, and a failed lookup must fail closed.
test("Mac approval guard reads the installed requirement and rejects incompatible signed candidates", () => {
  const root = mkdtempSync(join(tmpdir(), "cubby-approval-"));
  const previousPath = process.env.PATH;
  try {
    writeFileSync(
      join(root, "codesign"),
      `#!${process.execPath}\nconst args=process.argv.slice(2);\nif(args[0]==='-d') { console.error('designated => identifier "synthetic.app"'); process.exit(args.at(-1)==='unreadable' ? 1 : 0); }\nif(!args.includes('-R=identifier "synthetic.app"') || args.at(-1)==='incompatible') process.exit(1);\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${root}:${previousPath}`;
    const verify = installedApprovalVerifier("installed");
    verify("compatible");
    assert.throws(() => verify("incompatible"), /privacy requirement/);
    assert.throws(
      () => installedApprovalVerifier("unreadable"),
      /read.*requirement/,
    );
  } finally {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});
