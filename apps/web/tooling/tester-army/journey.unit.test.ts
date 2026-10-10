import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

import { z } from "zod";

import {
  JourneyIds,
  type Journey,
  assertScreenRead,
  replayParams,
  selectedJourneys,
} from "./journey";

afterEach(() => vi.unstubAllEnvs());

const journey = (id: string, extra: Partial<Journey> = {}): Journey => ({
  id,
  title: id,
  steps: [],
  visible: () => [],
  db: [],
  ...extra,
});

// A journey whose control only the web app renders must never enter an iOS
// run, where the agent cannot complete it; naming it there is a usage error.
it("keeps web-only journeys out of iOS runs", () => {
  const catalog = [
    journey("shared"),
    journey("web-control", { webOnly: true }),
    journey("coupled-import", { coupled: true }),
  ];
  expect(selectedJourneys(catalog, "ios").map((j) => j.id)).toEqual(["shared"]);
  expect(selectedJourneys(catalog, "web").map((j) => j.id)).toEqual([
    "shared",
    "web-control",
    "coupled-import",
  ]);
  vi.stubEnv("TESTER_ARMY_JOURNEYS", "web-control");
  expect(() => selectedJourneys(catalog, "ios")).toThrow(/Web-only/u);
});

// A screen read decides a verdict, so it must fail on a wrong value, ignore
// key order, and invert under `--wrong` so the corrupted run fails there.
it("compares what the agent read exactly", () => {
  const ids = new JourneyIds({}, "read");
  const read = {
    instruction: "the run's facts",
    schema: z.object({ work: z.string(), changed: z.number() }),
    expected: () => ({ work: "Product enrichment", changed: 1 }),
  };
  const same = { changed: 1, work: "Product enrichment" };
  expect(() =>
    assertScreenRead({ id: "read" }, read, same, ids, false),
  ).not.toThrow();
  expect(() =>
    assertScreenRead({ id: "read" }, read, { ...same, changed: 2 }, ids, false),
  ).toThrow(/Screen read failed/u);
  expect(() => assertScreenRead({ id: "read" }, read, same, ids, true)).toThrow(
    /unexpectedly matched/u,
  );
});

// Regression: `--replay` reported `replayed 0, missed 1` on every warm run.
// Each run seeds fresh codes, and the SDK reads `/PRD-4K7M` as a literal
// route segment, so a recording's start screen never matched the next run's
// (`wrong-context`). Marking the seeded codes `unique()` templates them out
// of the cache key and the recorded paths. Uses the pinned SDK's own cache
// modules, which its package exports do not expose.
it("lets a recording replay against the next seed's codes", async () => {
  const dist = path.dirname(createRequire(import.meta.url).resolve("e2e"));
  const load = (file: string) =>
    import(pathToFileURL(path.join(dist, file)).href);
  const { sameRoute } = await load("cache/route.js");
  const { templateParams, templateText, expandText } =
    await load("cache/template.js");
  const { validateParams } = await load("agent/act-validation.js");
  const templateList = z.array(
    z.object({ pointer: z.string(), value: z.string() }),
  );
  const seed = (product: string) => {
    const ids = new JourneyIds(
      { product, origin: "http://localhost:8787" },
      "replay",
    );
    const { projected, templates } = validateParams(replayParams(ids));
    return { projected, templates: templateList.parse(templates) };
  };
  const recorded = seed("PRD-4K7M");
  const next = seed("PRD-ZZZZ");
  expect(sameRoute("/PRD-4K7M", "/PRD-ZZZZ")).toBe(false);
  expect(templateParams(next.projected, next.templates)).toEqual(
    templateParams(recorded.projected, recorded.templates),
  );
  const replayed = expandText(
    templateText("/PRD-4K7M/edit", recorded.templates),
    new Map(next.templates.map((t) => [t.pointer, t.value])),
  );
  expect(sameRoute(replayed, "/PRD-ZZZZ/edit")).toBe(true);
  // A non-code seed value stays out: marking it would template every
  // occurrence of an ordinary string in the recording.
  expect(next.templates.map((t) => t.value)).toEqual(["PRD-ZZZZ"]);
});
