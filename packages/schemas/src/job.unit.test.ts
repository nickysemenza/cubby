import { describe, expect, it } from "vitest";

import { describeJobRollup, describeJobWaitingOn } from "./job";

const now = new Date("2026-10-24T12:00:00.000Z");

describe("describeJobWaitingOn", () => {
  it("words due-now and zero-failure scheduled work without a failure backoff", () => {
    const waiting = {
      reason: "backing_off",
      lane: "server",
      attempts: 0,
      lastError: null,
      cause: null,
    } as const;
    expect(
      describeJobWaitingOn({ ...waiting, until: now.toISOString() }, now),
    ).toBe("Due now");
    expect(
      describeJobWaitingOn(
        { ...waiting, until: "2026-10-24T12:00:01.000Z" },
        now,
      ),
    ).toBe("Due in 1 s");
    expect(
      describeJobWaitingOn(
        { ...waiting, attempts: 5, until: now.toISOString() },
        now,
      ),
    ).toBe("Due now");
  });
  it("names an expired lease instead of reading as in progress", () => {
    expect(
      describeJobWaitingOn(
        {
          reason: "leased",
          lane: "apple_device",
          executor: "Fixture Mac",
          executorDeviceId: null,
          leasedAt: "2026-10-24T11:50:00.000Z",
          leaseExpiresAt: "2026-10-24T11:58:00.000Z",
          expired: true,
        },
        now,
      ),
    ).toBe("Lease on Fixture Mac expired; waiting to be reclaimed");
    expect(
      describeJobWaitingOn(
        {
          reason: "leased",
          lane: "apple_device",
          executor: "Fixture Mac",
          executorDeviceId: null,
          leasedAt: "2026-10-24T11:50:00.000Z",
          leaseExpiresAt: "2026-10-24T12:01:00.000Z",
          expired: false,
        },
        now,
      ),
    ).toBe("In progress on Fixture Mac");
  });

  it("states queue, funding windows and backoff", () => {
    expect(
      describeJobWaitingOn(
        {
          reason: "waiting_device",
          lane: "apple_device",
        },
        now,
      ),
    ).toBe("Waiting for any Apple device");
    expect(
      describeJobWaitingOn(
        {
          reason: "waiting_funding",
          lane: "frontier_ai",
          until: "2026-10-24T15:00:00.000Z",
        },
        now,
      ),
    ).toBe("Waiting for AI funding for 3 h");
    expect(
      describeJobWaitingOn(
        {
          reason: "backing_off",
          lane: "frontier_ai",
          until: "2026-10-24T12:00:30.000Z",
          attempts: 6,
          lastError: "synthetic failure",
          cause: null,
        },
        now,
      ),
    ).toBe("Backing off for 30 s after 6 failures");
    expect(describeJobWaitingOn(null, now)).toBeNull();
  });
});

describe("describeJobRollup", () => {
  it("counts live Jobs in the fixed reason order and is null when none", () => {
    expect(describeJobRollup({ leased: 3, due: 12 })).toBe(
      "12 due · 3 in progress",
    );
    expect(describeJobRollup({ waiting_device: 4 })).toBe(
      "4 waiting for any Apple device",
    );
    expect(describeJobRollup({})).toBeNull();
  });
});
