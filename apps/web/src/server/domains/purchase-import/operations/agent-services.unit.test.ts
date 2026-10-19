/**
 * Failures: one pool-slot timeout during frontier admission fails the whole
 * coordinator Run; a final database failure reaches the coordinator without
 * its Postgres cause (Workers RPC keeps only the message).
 */
import { describe, expect, it } from "vitest";

import { admissionRead } from "./agent-services";

const queryFailure = (code: string, message: string) =>
  new Error('Failed query: select "purpose" from "Run"', {
    cause: Object.assign(new Error(message), { code }),
  });
const noWait = async () => undefined;

describe("admissionRead", () => {
  it("retries a pool-slot timeout", async () => {
    let calls = 0;
    const result = await admissionRead(async () => {
      calls += 1;
      if (calls < 3)
        throw queryFailure(
          "58000",
          "Timed out while waiting for an open slot in the pool.",
        );
      return "admitted";
    }, noWait);
    expect(result).toBe("admitted");
    expect(calls).toBe(3);
  });

  it("names the Postgres cause of a failure it does not retry", async () => {
    let calls = 0;
    const failure = await admissionRead(async () => {
      calls += 1;
      throw queryFailure("42P01", 'relation "Run" does not exist');
    }, noWait).catch((error: unknown) => error);
    expect(calls).toBe(1);
    expect(String(failure)).toContain(
      'cause: 42P01 relation "Run" does not exist',
    );
  });
});
