import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { macFixtureSigningIdentity } from "../apps/web/tooling/mac-fixture-identity.ts";

const cacheSchema = z.object({ key: z.string(), binarySHA256: z.string() });
const sha = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const identifier = "com.cubby.fixture.presentationax";

/** Caller holds the host Mac fixture lease. A stable path and Apple-issued
 * designated identity retain Accessibility consent when source code changes. */
export function ensureMacPresentationHelper(
  source: string,
  directory: string,
  identity: ReturnType<typeof macFixtureSigningIdentity>,
) {
  if (identity.selector === "-" || !/^[A-Z\d]{10}$/u.test(identity.team))
    throw new Error(
      "Presentation helper requires the fixture's Developer ID identity",
    );
  mkdirSync(directory, { recursive: true });
  const binary = path.join(directory, "mac-presentation-ax");
  const metadata = `${binary}.json`;
  const sourceSHA256 = sha(readFileSync(source));
  const compiler = execFileSync("xcrun", ["swiftc", "--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const key = sha(
    JSON.stringify([
      sourceSHA256,
      compiler,
      identity.selector,
      identity.team,
      identifier,
    ]),
  );
  let cached: z.infer<typeof cacheSchema> | undefined;
  try {
    cached = cacheSchema.parse(JSON.parse(readFileSync(metadata, "utf8")));
  } catch {
    /* Missing/corrupt metadata cannot establish reuse. */
  }
  const reused =
    !!cached &&
    cached.key === key &&
    existsSync(binary) &&
    cached.binarySHA256 === sha(readFileSync(binary));
  const requirement = `identifier "${identifier}" and anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${identity.team}"`;
  const verify = (file: string) =>
    execFileSync(
      "codesign",
      ["--verify", "--strict", `-R=${requirement}`, file],
      { stdio: "pipe", timeout: 10_000 },
    );
  if (reused) verify(binary);
  else {
    const pending = `${binary}.pending`;
    try {
      execFileSync("xcrun", ["swiftc", source, "-o", pending], {
        stdio: "pipe",
        timeout: 30_000,
      });
      execFileSync(
        "codesign",
        [
          "--force",
          "--sign",
          identity.selector,
          "--identifier",
          identifier,
          pending,
        ],
        { stdio: "pipe", timeout: 30_000 },
      );
      verify(pending);
      renameSync(pending, binary);
      writeFileSync(
        metadata,
        JSON.stringify({ key, binarySHA256: sha(readFileSync(binary)) }),
      );
    } catch (error) {
      // Child process errors include the personal certificate selector.
      const message = String(error).replaceAll(
        identity.selector,
        "[configured Developer ID]",
      );
      // eslint-disable-next-line preserve-caught-error -- The original subprocess error includes the personal signing selector.
      throw new Error(`Presentation helper build failed: ${message}`, {
        cause: new Error(message),
      });
    } finally {
      rmSync(pending, { force: true });
    }
  }
  return {
    binary,
    sourceSHA256,
    binarySHA256: sha(readFileSync(binary)),
    reused,
  };
}
