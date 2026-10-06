import { afterEach, expect, it, vi } from "vitest";

import { type Journey, selectedJourneys } from "./journey";

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
