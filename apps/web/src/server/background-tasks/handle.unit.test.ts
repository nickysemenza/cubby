import { testEntityId } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";

import {
  handleBackgroundTask,
  type BackgroundTaskOutcome,
  type BackgroundTaskPorts,
} from "./handle";

// SAFETY: every database operation in this unit is replaced by an injected
// port; the object is only an opaque transaction identity token.
const database = {} as Database;
const imageId = testEntityId("image", "metadata-task");

const portsWithExtractOutcome = (
  outcome: BackgroundTaskOutcome,
): BackgroundTaskPorts => ({
  // SAFETY: `embedding` is unused by the "image-metadata.extract" branch
  // this suite exercises; a real value is never called.
  embedding: {} as BackgroundTaskPorts["embedding"],
  extractImageMetadata: async () => outcome,
});

describe("handleBackgroundTask: image-metadata.extract", () => {
  it("delegates to the injected extractImageMetadata port and reports its outcome", async () => {
    const outcome = await handleBackgroundTask(
      database,
      {
        kind: "image-metadata.extract",
        requestedAt: "2026-01-01T00:00:00.000Z",
        imageId,
      },
      portsWithExtractOutcome("succeeded"),
    );

    expect(outcome).toBe("succeeded");
  });

  it("passes through a skipped outcome (already fresh, missing bytes, or not found)", async () => {
    const outcome = await handleBackgroundTask(
      database,
      {
        kind: "image-metadata.extract",
        requestedAt: "2026-01-01T00:00:00.000Z",
        imageId,
      },
      portsWithExtractOutcome("skipped"),
    );

    expect(outcome).toBe("skipped");
  });
});
