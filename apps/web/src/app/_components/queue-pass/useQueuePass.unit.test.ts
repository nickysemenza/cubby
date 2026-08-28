import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  parseStoredQueuePass,
  type QueuePassPersistence,
} from "./useQueuePass";

const persistence: QueuePassPersistence<{ note: string }> = {
  storageKey: (scope) => `queue:${scope}`,
  version: 2,
  extraSchema: z.object({ note: z.string() }),
};

type StoredExtraFixture = { note: string } | { note: number };

const stored = (extra: StoredExtraFixture) =>
  JSON.stringify({
    version: 2,
    startedAt: 10,
    updatedAt: 20,
    currentIndex: 1,
    completed: ["A"],
    skipped: [],
    totalCount: 2,
    extra,
  });

describe("parseStoredQueuePass", () => {
  it("returns a flow payload only after its owner schema parses it", () => {
    expect(
      parseStoredQueuePass(stored({ note: "resume" }), persistence),
    ).toMatchObject({
      extra: { note: "resume" },
    });
  });

  it("refuses malformed flow payloads", () => {
    expect(parseStoredQueuePass(stored({ note: 42 }), persistence)).toBeNull();
  });

  it("refuses malformed JSON", () => {
    expect(parseStoredQueuePass("not json", persistence)).toBeNull();
  });
});
