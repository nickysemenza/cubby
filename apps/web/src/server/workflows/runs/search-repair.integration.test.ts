import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { activateWorkflowDeployment } from "./activation";
import { isWorkflowInterrupted } from "./execution";
import { continueSearchRepair } from "./search-repair";

const ctx = withTestDb();

it("gates search successors on activated code and retains each rollback epoch", async () => {
  const launched: unknown[] = [];
  let version = "synthetic-a";
  const port = {
    version: () => version,
    createBatch: async (input: unknown) => {
      launched.push(input);
      return { created: [{ id: "synthetic-search-next" }], errors: [] };
    },
  };
  const input = {
    id: "synthetic-search-next",
    params: { requestedAt: "2026-10-01T00:00:00.000Z" },
  };
  await activateWorkflowDeployment(ctx.db, {
    deploymentId: "synthetic-deploy-a",
    workerVersion: version,
    expectedEpoch: 0,
  });
  await activateWorkflowDeployment(ctx.db, {
    deploymentId: "synthetic-deploy-b",
    workerVersion: "synthetic-b",
    expectedEpoch: 1,
  });
  await expect(continueSearchRepair(ctx.db, input, port)).rejects.toSatisfy(
    isWorkflowInterrupted,
  );
  expect(launched).toEqual([]);
  await activateWorkflowDeployment(ctx.db, {
    deploymentId: "synthetic-rollback-a",
    workerVersion: version,
    expectedEpoch: 2,
  });
  await continueSearchRepair(ctx.db, input, port);
  expect(launched).toMatchObject([
    { instances: [{ params: { activationEpoch: 3 } }] },
  ]);
  version = "synthetic-b";
  await expect(continueSearchRepair(ctx.db, input, port)).rejects.toSatisfy(
    isWorkflowInterrupted,
  );
  expect(launched).toHaveLength(1);
});

it("accepts a lost-ack duplicate search successor and exposes other provider errors", async () => {
  await activateWorkflowDeployment(ctx.db, {
    deploymentId: "synthetic-deploy-a",
    workerVersion: "synthetic-a",
    expectedEpoch: 0,
  });
  const input = {
    id: "synthetic-search-next",
    params: { requestedAt: "2026-10-01T00:00:00.000Z" },
  };
  let code = 10405;
  const port = {
    version: () => "synthetic-a",
    createBatch: async () => ({
      created: [],
      errors: [{ index: 0, code, message: "Synthetic provider refusal" }],
    }),
  };
  await expect(
    continueSearchRepair(ctx.db, input, port),
  ).resolves.toBeUndefined();
  code = 10000;
  await expect(continueSearchRepair(ctx.db, input, port)).rejects.toThrow(
    "Synthetic provider refusal",
  );
});
