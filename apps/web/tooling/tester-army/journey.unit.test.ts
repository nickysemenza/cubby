import { afterEach, expect, it, vi } from "vitest";

import { z } from "zod";

import {
  JourneyIds,
  type Journey,
  assertScreenRead,
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
