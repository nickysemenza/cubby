import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { digestTree } from "../../../scripts/lib/tree-digest.ts";

export const macFixtureBundleID = "com.nickysemenza.cubby.e2e";
export const macFixtureBrowserBundleID = "com.cubby.fixture.browser";
export function macFixturePaths() {
  const root = path.join(homedir(), "Library/Caches/CubbyMacImportFixture");
  return {
    root,
    app: path.join(root, "Cubby.app"),
    browser: path.join(root, "FixtureBrowser.app"),
  };
}

type SigningIdentity = { selector: string; team: string };
/** Reject ad-hoc, unavailable and ambiguous identities before any app or signing operation. */
export function selectMacFixtureSigningIdentity(
  inventory: string,
  team: string,
  requested?: string,
): SigningIdentity {
  const available = [
    ...inventory.matchAll(
      /^\s*\d+\)\s+([a-f\d]{40})\s+"(Developer ID Application: [^"\n]+ \(([A-Z\d]{10})\))"/gimu,
    ),
  ].filter(
    (entry) =>
      entry[3] === team &&
      (!requested || requested === entry[1] || requested === entry[2]),
  );
  if (!/^[A-Z\d]{10}$/u.test(team) || available.length !== 1)
    throw new Error(
      "Unattended Mac fixtures require exactly one available Developer ID Application identity for the project team. Install it or set CUBBY_E2E_SIGNING_IDENTITY to a matching identity; ad-hoc signing is refused.",
    );
  return { selector: available[0]![1]!, team };
}
export function macFixtureSigningIdentity(repoRoot: string): SigningIdentity {
  const project = readFileSync(
    path.join(repoRoot, "apps/apple/project.yml"),
    "utf8",
  );
  const team = project.match(
    /^\s*DEVELOPMENT_TEAM:\s*([A-Z\d]{10})\s*$/mu,
  )?.[1];
  if (!team)
    throw new Error(
      "Mac fixture signing requires the project's development team",
    );
  return selectMacFixtureSigningIdentity(
    execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
      timeout: 10000,
    }),
    team,
    process.env.CUBBY_E2E_SIGNING_IDENTITY,
  );
}

/** Stable identities are host-wide: a second runner must never replace or quit the first one's app. */
export function acquireMacFixtureLease(root: string, nonce: string) {
  mkdirSync(root, { recursive: true });
  const directory = path.join(root, "run.lock");
  try {
    mkdirSync(directory);
  } catch (error) {
    if (z.object({ code: z.literal("EEXIST") }).safeParse(error).success)
      throw new Error(
        "Stable Mac fixture identity is already leased. Wait for the other fixture run to finish; inspect a stale run.lock before removing it. No app was replaced or terminated.",
        { cause: error },
      );
    throw error;
  }
  const owner = path.join(directory, "owner.json");
  writeFileSync(owner, JSON.stringify({ nonce, pid: process.pid }));
  let released = false;
  return {
    root,
    nonce,
    release() {
      if (released) return;
      const current = z
        .object({ nonce: z.string(), pid: z.number() })
        .parse(JSON.parse(readFileSync(owner, "utf8")));
      if (current.nonce !== nonce || current.pid !== process.pid)
        throw new Error("Mac fixture lease owner changed; refusing cleanup");
      rmSync(directory, { recursive: true });
      released = true;
    },
  };
}
export function assertFixtureProcessesAbsent(
  processes: string,
  apps: string[],
): void {
  const existing = processes.split("\n").find((line) =>
    apps.some((app) => {
      const command = line.trim().replace(/^\d+\s+/u, "");
      return command.startsWith(`${app}/Contents/`);
    }),
  );
  if (existing)
    throw new Error(
      "Stable Mac fixture app is already running. Stop its owning run before retrying; no app was replaced or terminated.",
    );
}
export function assertMacFixturesIdle(): void {
  const apps = macFixturePaths();
  assertFixtureProcessesAbsent(
    execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }),
    [apps.app, apps.browser],
  );
}

export const nativeBundleFingerprint = (directory: string): string =>
  digestTree(directory, {
    skip: (name) => name === ".DS_Store",
    includeSymlinks: true,
  });

const signatureSchema = z.object({
  bundleID: z.string(),
  team: z.string(),
  certificateKind: z.literal("Developer ID Application"),
  requirementSHA256: z.string(),
  executableUUIDs: z.array(z.string()).min(1),
});
function fixtureSignature(app: string, bundleID: string, team: string) {
  const required = `anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}"`;
  execFileSync(
    "codesign",
    ["--verify", "--deep", "--strict", `-R=${required}`, app],
    { stdio: "pipe", timeout: 20000 },
  );
  // codesign emits certificate names on stderr. Keep them in-process; artifacts retain only public team/type and a requirement digest.
  const details = execFileSync(
    "sh",
    ["-c", 'codesign -dvvv "$1" 2>&1', "fixture-signature", app],
    { encoding: "utf8", timeout: 10000 },
  );
  if (
    !details.includes(`Identifier=${bundleID}\n`) ||
    !details.includes(`TeamIdentifier=${team}\n`) ||
    !details.includes("Authority=Developer ID Application:")
  )
    throw new Error(
      "Mac fixture signature does not match its stable bundle, project team and Developer ID Application certificate",
    );
  const requirement = execFileSync(
    "sh",
    ["-c", 'codesign -d -r- "$1" 2>&1', "fixture-requirement", app],
    { encoding: "utf8", timeout: 10000 },
  );
  const executable = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleExecutable", path.join(app, "Contents/Info.plist")],
    { encoding: "utf8" },
  ).trim();
  const uuidOutput = execFileSync(
    "xcrun",
    ["dwarfdump", "--uuid", path.join(app, "Contents/MacOS", executable)],
    { encoding: "utf8", timeout: 10000 },
  );
  const executableUUIDs = [
    ...uuidOutput.matchAll(/^UUID: ([a-f\d-]+) /gimu),
  ].map((match) => match[1]!);
  return signatureSchema.parse({
    bundleID,
    team,
    certificateKind: "Developer ID Application",
    requirementSHA256: createHash("sha256").update(requirement).digest("hex"),
    executableUUIDs,
  });
}

/** Retain one signed path across runs; rebuild only when verified inputs change. No permissions are modified. */
export function prepareMacFixtureApp(input: {
  source: string;
  target: string;
  bundleID: string;
  identity: SigningIdentity;
  entitlements?: string;
}) {
  const sourceFingerprint = nativeBundleFingerprint(input.source);
  const configuration = createHash("sha256")
    .update(
      JSON.stringify([
        "developer-id-v1",
        sourceFingerprint,
        input.bundleID,
        input.identity.selector,
        input.entitlements
          ? readFileSync(input.entitlements, "utf8")
          : "preserve-entitlements",
      ]),
    )
    .digest("hex");
  const metadataPath = `${input.target}.identity.json`;
  const cachedSchema = z.object({
    configuration: z.string(),
    signedFingerprint: z.string(),
    signature: signatureSchema,
  });
  const cached = existsSync(metadataPath)
    ? cachedSchema.safeParse(JSON.parse(readFileSync(metadataPath, "utf8")))
    : undefined;
  if (
    cached?.success &&
    cached.data.configuration === configuration &&
    existsSync(input.target) &&
    cached.data.signedFingerprint === nativeBundleFingerprint(input.target)
  ) {
    const signature = fixtureSignature(
      input.target,
      input.bundleID,
      input.identity.team,
    );
    if (signature.requirementSHA256 !== cached.data.signature.requirementSHA256)
      throw new Error("Cached Mac fixture signing requirement changed");
    return {
      sourceFingerprint,
      signedFingerprint: cached.data.signedFingerprint,
      signature,
      reused: true,
    };
  }
  // Caller holds the host lease and has checked for any running fixture process before this replacement.
  rmSync(input.target, { recursive: true, force: true });
  execFileSync("ditto", [input.source, input.target]);
  execFileSync("/usr/libexec/PlistBuddy", [
    "-c",
    `Set :CFBundleIdentifier ${input.bundleID}`,
    path.join(input.target, "Contents/Info.plist"),
  ]);
  const flags = input.entitlements
    ? ["--entitlements", input.entitlements]
    : ["--preserve-metadata=entitlements"];
  try {
    execFileSync(
      "codesign",
      [
        "--force",
        "--deep",
        "--sign",
        input.identity.selector,
        ...flags,
        input.target,
      ],
      { stdio: "pipe", timeout: 30000 },
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.replaceAll(
            input.identity.selector,
            "[configured Developer ID]",
          )
        : "Unknown codesign failure";
    // The original child-process error embeds the local certificate selector in its command and args.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Apple-issued fixture signing failed: ${message}`, {
      cause: new Error(message),
    });
  }
  const signature = fixtureSignature(
    input.target,
    input.bundleID,
    input.identity.team,
  );
  const signedFingerprint = nativeBundleFingerprint(input.target);
  writeFileSync(
    metadataPath,
    JSON.stringify({ configuration, signedFingerprint, signature }, null, 2) +
      "\n",
  );
  return { sourceFingerprint, signedFingerprint, signature, reused: false };
}
