import { describe, expect, it } from "vitest";

import {
  describeJobRollup,
  describeJobWaitingOn,
  ordinalText,
  summarizeRunWait,
} from "./job";

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

describe("summarizeRunWait", () => {
  const clock = (at: Date) => `${at.getUTCHours()}:00 UTC`;
  const input = {
    now,
    formatTime: clock,
    waitingForFunding: false,
    fundingResumeAt: null,
    groups: [],
    perMinute: new Map<string, number>(),
    paceMinutes: 5,
    counts: {},
    expiredLeases: 0,
    stalled: false,
  };
  const capacity = {
    kind: "purchase.dispatch",
    reason: "provider_capacity",
    mine: 3,
    position: 23,
    total: 36,
    nextAt: now,
    errorClass: null,
  } as const;

  // A Run once read only "1 backing off" with no reason, place in line or ETA.
  it("places the Run in its kind's line and estimates from the recent pace", () => {
    const wait = summarizeRunWait({
      ...input,
      groups: [
        capacity,
        { ...capacity, reason: "retry", mine: 1, errorClass: "TimeoutError" },
      ],
      perMinute: new Map([["purchase.dispatch", 1.4]]),
      counts: { backing_off: 4 },
    });
    expect(wait).toMatchObject({
      reason: "model_capacity",
      position: 23,
      total: 36,
      perMinute: 1.4,
      // 23 ÷ 1.4 per minute ≈ 16.4 minutes.
      etaAt: new Date(now.getTime() + (23 / 1.4) * 60_000).toISOString(),
      label: "Queued for model capacity · 23rd of 36 · about 16 min",
      jobs: "4 backing off",
    });
    expect(summarizeRunWait({ ...input, groups: [capacity] })?.label).toBe(
      "Queued for model capacity · 23rd of 36 · pace unknown",
    );
  });

  it("leads with funding and names the resume time or the retry's error", () => {
    const resume = new Date("2026-10-24T18:01:00.000Z");
    expect(
      summarizeRunWait({
        ...input,
        groups: [{ ...capacity, mine: 30 }],
        waitingForFunding: true,
        fundingResumeAt: resume,
      }),
    ).toMatchObject({
      reason: "funding",
      etaAt: resume.toISOString(),
      label: "Waiting for AI funding · resumes 18:00 UTC",
    });
    expect(
      summarizeRunWait({
        ...input,
        groups: [
          {
            ...capacity,
            reason: "retry",
            errorClass: "GatewayBillingError",
            nextAt: new Date(now.getTime() + 4 * 60_000),
          },
        ],
      })?.label,
    ).toBe(
      "Retrying after an error (GatewayBillingError) · next try in about 4 min",
    );
  });

  it("reads a stalled Run with no live work as never finished", () => {
    expect(summarizeRunWait(input)).toBeNull();
    expect(summarizeRunWait({ ...input, stalled: true })?.label).toBe(
      "No work left, but the Run never finished",
    );
  });

  it("writes English ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 111].map(ordinalText)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "111th",
    ]);
  });
});
