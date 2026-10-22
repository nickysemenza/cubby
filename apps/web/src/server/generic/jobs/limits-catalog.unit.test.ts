import { BACKGROUND_QUEUE_CONSUMER } from "@cubby/shared/background-queue";
import { describe, expect, it } from "vitest";

import { GATEWAY_EGRESS_LIMITS } from "~/server/ai/gateway-egress-contract";
import { TRANSFER_PAIR_PUBLICATION_CONCURRENCY } from "~/server/domains/financial-transaction/repo/transfer-pair-suggestions";
import { STATEMENT_PUBLISH_CONCURRENCY } from "~/server/domains/transaction-import/repo/statement-suggestions";

import { JOB_DRAIN } from "./limits";
import {
  type BindingInput,
  evaluateBinding,
  LIMITS_CATALOG,
} from "./limits-catalog";
import { JOB_LEASE_MS } from "./repo/jobs";

const now = new Date("2026-03-02T12:00:00Z");
const job = (patch: Partial<NonNullable<BindingInput["job"]>> = {}) => ({
  kind: "run.execute",
  state: "running" as const,
  waitReason: null,
  waitUntil: null,
  availableAt: new Date("2026-03-02T11:00:00Z"),
  attempts: 1,
  maxAttempts: 3,
  ahead: null,
  ...patch,
});
const running = (step: BindingInput["step"]): BindingInput => ({
  job: job(),
  runningJobs: 1,
  step,
  now,
});

describe("limits catalog", () => {
  it("reads each value from the constant or config that enforces it", () => {
    const value = (key: string) =>
      LIMITS_CATALOG.find((limit) => limit.key === key)?.value;
    expect(value("queue.concurrency")).toBe(
      BACKGROUND_QUEUE_CONSUMER.maxConcurrency,
    );
    expect(value("drain.time")).toBe(JOB_DRAIN.timeBudgetMs);
    expect(value("lease.duration")).toBe(JOB_LEASE_MS);
    expect(value("gateway.inflight")).toBe(
      GATEWAY_EGRESS_LIMITS.unifiedMaxInFlight,
    );
    expect(value("page.transfer_publication")).toBe(
      TRANSFER_PAIR_PUBLICATION_CONCURRENCY,
    );
    expect(value("page.statement_publication")).toBe(
      STATEMENT_PUBLISH_CONCURRENCY,
    );
  });
});

describe("evaluateBinding", () => {
  it("names the limit a typed Job wait is held by", () => {
    expect(
      evaluateBinding({
        job: job({ state: "queued", waitReason: "provider_capacity" }),
        runningJobs: 0,
        step: null,
        now,
      }),
    ).toMatchObject({ status: "binding", key: "gateway.inflight" });
  });

  it("holds a due Job behind busy consumers", () => {
    expect(
      evaluateBinding({
        job: job({ state: "queued", ahead: 12 }),
        runningJobs: BACKGROUND_QUEUE_CONSUMER.maxConcurrency,
        step: null,
        now,
      }),
    ).toMatchObject({
      status: "binding",
      key: "queue.concurrency",
      evidence: expect.stringContaining("12 same-kind Jobs ahead"),
    });
  });

  it("never guesses without a page sample", () => {
    expect(
      evaluateBinding(
        running({ key: "transfer_pair_scan", lastPageMs: null, page: null }),
      ),
    ).toEqual({ status: "unknown", reason: "Unknown — no recent samples." });
  });

  it("reports a saturated in-page concurrency cap", () => {
    expect(
      evaluateBinding(
        running({
          key: "transfer_pair_scan",
          lastPageMs: 4_000,
          page: {
            timings: { preparation: 1_000, publication: 3_000 },
            queries: 40,
            concurrency: { publication: TRANSFER_PAIR_PUBLICATION_CONCURRENCY },
          },
        }),
      ),
    ).toMatchObject({
      status: "binding",
      key: "page.transfer_publication",
      evidence: `publication concurrency ${TRANSFER_PAIR_PUBLICATION_CONCURRENCY} of ${TRANSFER_PAIR_PUBLICATION_CONCURRENCY} busy`,
    });
  });

  it("falls back to the page's own work when no limiter binds", () => {
    expect(
      evaluateBinding(
        running({
          key: "statement_generate",
          lastPageMs: 10_000,
          page: {
            timings: {
              selection: 1_000,
              preparation: 6_100,
              publication: 2_900,
            },
            queries: 106,
            concurrency: { publication: 1 },
          },
        }),
      ),
    ).toEqual({
      status: "binding",
      key: null,
      label: "Page work",
      evidence: "preparation 61% of page time · 106 queries/page",
    });
  });

  it("names the drain budget when a page nearly fills it", () => {
    expect(
      evaluateBinding(
        running({
          key: "orphans",
          lastPageMs: JOB_DRAIN.timeBudgetMs,
          page: null,
        }),
      ),
    ).toMatchObject({ status: "binding", key: "drain.time" });
  });
});
