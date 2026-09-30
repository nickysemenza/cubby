import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireMacFixtureLease,
  assertFixtureProcessesAbsent,
  selectMacFixtureSigningIdentity,
} from "./mac-fixture-identity";

const team = "SYNTH12345";
const first = "1".repeat(40);
const second = "2".repeat(40);
const inventory = `1) ${first} "Developer ID Application: Synthetic Fixture (${team})"\n2) ${second} "Apple Development: Synthetic Fixture (${team})"`;
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("unattended Mac fixture identity boundary", () => {
  it("selects an available Developer ID from the configured project team", () => {
    expect(selectMacFixtureSigningIdentity(inventory, team).selector).toBe(
      first,
    );
    expect(selectMacFixtureSigningIdentity(inventory, team, first).team).toBe(
      team,
    );
  });

  it.each([
    ["", undefined],
    [inventory, "-"],
    [inventory, second],
    [inventory.replaceAll(team, "OTHER12345"), undefined],
    [
      `${inventory}\n3) ${"3".repeat(40)} "Developer ID Application: Other Synthetic Fixture (${team})"`,
      undefined,
    ],
  ])(
    "refuses unavailable, ad-hoc, wrong-type, wrong-team or ambiguous signing",
    (available, requested) => {
      expect(() =>
        selectMacFixtureSigningIdentity(available, team, requested),
      ).toThrow(/Developer ID Application/);
    },
  );

  it("prevents concurrent runs from replacing a shared fixture and releases only its own lease", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cubby-fixture-identity-"));
    temporary.push(root);
    const owned = acquireMacFixtureLease(root, "first-run");
    expect(() => acquireMacFixtureLease(root, "second-run")).toThrow(
      /already leased/,
    );
    owned.release();
    const next = acquireMacFixtureLease(root, "second-run");
    owned.release();
    expect(() => acquireMacFixtureLease(root, "third-run")).toThrow(
      /already leased/,
    );
    next.release();
    acquireMacFixtureLease(root, "third-run").release();
  });

  it("rejects an already-running fixture before staging or launching while ignoring unrelated apps", () => {
    const apps = ["/synthetic/Cubby.app", "/synthetic/FixtureBrowser.app"];
    expect(() =>
      assertFixtureProcessesAbsent(
        "91 /synthetic/Cubby.app/Contents/MacOS/Cubby --fixture",
        apps,
      ),
    ).toThrow(/already running/);
    expect(() =>
      assertFixtureProcessesAbsent(
        "92 /synthetic/FixtureBrowser.app/Contents/MacOS/Chromium --fixture",
        apps,
      ),
    ).toThrow(/already running/);
    expect(() =>
      assertFixtureProcessesAbsent(
        "93 /Applications/Other.app/Contents/MacOS/Other",
        apps,
      ),
    ).not.toThrow();
  });
});
