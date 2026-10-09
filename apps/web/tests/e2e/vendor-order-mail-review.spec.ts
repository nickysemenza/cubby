import type { Page } from "@playwright/test";
import { researchAssessment } from "@cubby/schemas/research-assessment";
import { researchWorkResolve } from "@cubby/schemas/research-tools";
import { researchObjectivesRunInput } from "@cubby/schemas/run-fields";
import { eq } from "drizzle-orm";

import * as schema from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

import {
  getFixtureDb,
  ensureMemberParty,
  fixtureUserId,
} from "./fixtures-core";
import { authorizePurchaseAgent } from "~/server/purchase-import/purchase-agent-workerd.fixtures";
import { admitVendorResearch } from "~/server/purchase-import/vendor-research-run";
import { dispatchRunEvent } from "~/server/purchase-import/dispatch";
import {
  markRunFailed,
  updateAgentProgress,
} from "~/server/purchase-import/run-service";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { from, type ScriptStep } from "../../tooling/purchase-agent-script";
import type { E2EWorkerRuntime } from "./e2e-worker-runtime";
import type { Fixture } from "./harness-services/purchase-import-test-gateway";
import { seedVendorMailReviewPrerequisite } from "./fixtures-mail";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test.use({ workerdProfile: "purchase-agent" });

test("reviews a vendor email match through the generic report and shows the linked original on Purchase", async ({
  page,
}) => {
  const seed = await seedVendorMailReviewPrerequisite(
    page,
    `Synthetic Outfitters ${Date.now()}`,
  );
  await gotoAuthenticatedPage(
    page,
    `/vendors/${seed.vendor.shortcode}`,
    page.getByText("Synthetic order receipt"),
  );
  await expect(
    page.getByRole("button", { name: "Research purchases", exact: true }),
  ).toBeVisible();
  const exactRow = page.getByRole("listitem").filter({
    has: page.locator(`a[href="/purchases/${seed.purchase.shortcode}"]`),
  });
  await expect(
    exactRow.getByRole("link", {
      name: seed.purchase.shortcode,
      exact: true,
    }),
  ).toHaveAttribute("href", `/purchases/${seed.purchase.shortcode}`);
  await expect(
    exactRow.getByText("Suggested match", { exact: true }),
  ).toBeVisible();
  await exactRow
    .getByRole("button", { name: "Dismiss suggestion", exact: true })
    .click();
  await expect(exactRow.getByText("Dismissed", { exact: true })).toBeVisible();
  await page.reload();
  await expect(exactRow.getByText("Dismissed", { exact: true })).toBeVisible();
  await exactRow
    .getByRole("button", { name: "Link Purchase", exact: true })
    .click();
  await expect(exactRow.getByText("Linked", { exact: true })).toBeVisible();
  await gotoAuthenticatedPage(
    page,
    `/purchases/${seed.purchase.shortcode}`,
    page.getByText("Synthetic order receipt"),
  );
  await expect(
    page.getByRole("link", { name: "Open Gmail original" }),
  ).toHaveAttribute(
    "href",
    /^https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/synthetic-thread-/u,
  );
  await expect(page.getByText("Linked", { exact: true })).toBeVisible();
});

test("launches cloud Vendor purchase research from the generic report without a website or account", async ({
  page,
}) => {
  const seed = await seedVendorMailReviewPrerequisite(
    page,
    `Synthetic cloud research vendor ${Date.now()}`,
  );
  expect(seed.vendor.website).toBeNull();
  await gotoAuthenticatedPage(
    page,
    `/vendors/${seed.vendor.shortcode}`,
    page.getByRole("button", { name: "Research purchases", exact: true }),
  );
  await page
    .getByRole("button", { name: "Research purchases", exact: true })
    .click();
  await expect(page).toHaveURL(/\/runs\/RUN-[A-Z0-9]+$/u);
  const shortcode = page.url().split("/").at(-1);
  const [started] = await getDb(getFixtureDb())
    .select()
    .from(schema.run)
    .where(eq(schema.run.shortcode, shortcode!));
  if (!started)
    throw new Error("Generic report research did not persist a Run");
  expect(started.purpose).toBe("account_sync");
  expect(researchObjectivesRunInput.parse(started.input).objectives).toEqual([
    { kind: "vendor_purchases", vendorId: seed.vendor.id, range: null },
  ]);
  expect(
    await getDb(getFixtureDb())
      .select({ vendorId: schema.vendorAccount.vendorId })
      .from(schema.vendorAccount)
      .where(eq(schema.vendorAccount.vendorId, seed.vendor.id)),
  ).toEqual([]);
});

// Faults: saved diagnostics disappear, retry mutates old work, a late result
// reopens cancelled work, progress loses the frozen scope, or unresolved
// investigations render successful completion. Only external judgment is scripted.

const call = (
  id: string,
  tool: string,
  args: Extract<ScriptStep, { call: string }>["args"] = {},
): ScriptStep => ({ call: id, tool, args });
const historyURL = "https://synthetic-history.example.test/current";
const olderURL = "https://synthetic-history.example.test/older";

async function readRun(shortcode: string) {
  const [run] = await getDb(getFixtureDb())
    .select()
    .from(schema.run)
    .where(eq(schema.run.shortcode, shortcode));
  if (!run) throw new Error("Admitted synthetic research Run missing.");
  researchObjectivesRunInput.parse(run.input);
  return run;
}

async function records(runId: typeof schema.run.$inferSelect.id) {
  const db = getDb(getFixtureDb());
  const [targets, evidence, operations, progress] = await Promise.all([
    db
      .select()
      .from(schema.runTarget)
      .where(eq(schema.runTarget.runId, runId))
      .orderBy(schema.runTarget.id),
    db
      .select()
      .from(schema.runEvidence)
      .where(eq(schema.runEvidence.runId, runId))
      .orderBy(schema.runEvidence.id),
    db
      .select()
      .from(schema.runOperation)
      .where(eq(schema.runOperation.runId, runId))
      .orderBy(schema.runOperation.id),
    db
      .select()
      .from(schema.runProgress)
      .where(eq(schema.runProgress.runId, runId))
      .orderBy(schema.runProgress.id),
  ]);
  return { targets, evidence, operations, progress };
}

async function retainedRecords(
  runId: typeof schema.run.$inferSelect.id,
  expected: Awaited<ReturnType<typeof records>>,
) {
  const current = await records(runId);
  expect(current.targets).toEqual(expected.targets);
  expect(current.evidence).toEqual(expected.evidence);
  expect(current.operations).toEqual(
    expect.arrayContaining(expected.operations),
  );
  expect(current.progress).toEqual(expect.arrayContaining(expected.progress));
}

async function configure(
  runtime: E2EWorkerRuntime,
  steps: ScriptStep[],
  exhausted: boolean,
) {
  const agent = runtime.purchaseAgent;
  if (!agent) throw new Error("The purchase-agent peer is unavailable.");
  const assessments = [
    {
      match: "Synthetic scope resolution",
      output: researchAssessment.parse({
        identityVerified: true,
        scopeCompletionVerified: exhausted,
        acceptedFacts: [],
        acceptedIdentifiers: [],
        acceptedImages: [],
        acceptedOrders: [],
        acceptedEmailLinks: [],
        rejected: [],
      }),
    },
  ];
  await agent.configure({ steps, assessments });
  const fixture: Fixture = {
    extractions: [],
    assessments,
    audit: { findings: [] },
    sources: [
      {
        url: historyURL,
        title: "Synthetic current history",
        description: "Retained synthetic Vendor history.",
        html: "<h1>Synthetic current history</h1><p>This page lists current synthetic orders. Older history is a separate page.</p>",
      },
      {
        url: olderURL,
        title: "Synthetic older history",
        description: "Retained synthetic older Vendor history.",
        html: "<h1>Synthetic older history</h1><p>This is the final synthetic history page for the assigned Vendor scope.</p>",
      },
    ],
  };
  const configured = await runtime.harness
    .getWorker("cubby-test-gateway")
    .fetch("https://gateway.test/configure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fixture),
    });
  if (!configured.ok)
    throw new Error(
      `Synthetic source peer configuration ${configured.status}: ${await configured.text()}`,
    );
  return agent;
}

async function launch(page: Page, name: string) {
  const member = await ensureMemberParty(page, name);
  const vendor = await insertWithShortcode(getFixtureDb(), "vendor", { name });
  await authorizePurchaseAgent(getFixtureDb(), await fixtureUserId(page));
  await gotoAuthenticatedPage(
    page,
    `/vendors/${vendor.shortcode}`,
    page.getByRole("button", { name: "Research purchases", exact: true }),
  );
  await page
    .getByRole("button", { name: "Research purchases", exact: true })
    .click();
  await expect(page).toHaveURL(/\/runs\/RUN-[A-Z0-9]+$/u);
  const shortcode = page.url().split("/").at(-1);
  if (!shortcode) throw new Error("Research launch omitted its Run reference.");
  const run = await readRun(shortcode);
  expect(run.ledgerPartyId).toBe(member.id);
  expect(researchObjectivesRunInput.parse(run.input).objectives).toEqual([
    { kind: "vendor_purchases", vendorId: vendor.id, range: null },
  ]);
  return { run, vendor };
}

const investigation: ScriptStep[] = [
  call("scope", "work_next"),
  call("current-page", "web_read", {
    workRef: from("scope", "work.workRef"),
    url: historyURL,
  }),
];
function resolution(exhausted: boolean): ScriptStep {
  const status = exhausted ? "verified" : "researched_with_gaps";
  // Validate authored operands before expensive infrastructure; references below
  // are replaced by the actual server-issued task and evidence IDs in the peer.
  researchWorkResolve.parse({
    workRef: "00000000-0000-4000-8000-000000000001",
    status,
    identity: {
      evidenceIds: ["00000000-0000-4000-8000-000000000002"],
      reasoning:
        "Synthetic scope resolution uses both retained history pages for this exact assigned Vendor.",
    },
    progress: {
      scopeExhausted: exhausted,
      evidenceIds: ["00000000-0000-4000-8000-000000000002"],
      gaps: exhausted ? [] : ["Older source coverage remains unverified."],
    },
    detail: "Synthetic scope resolution",
  });
  return call("resolve", "work_resolve", {
    workRef: from("scope", "work.workRef"),
    status,
    identity: {
      evidenceIds: [
        from("current-page", "evidenceId"),
        from("older-page", "evidenceId"),
      ],
      reasoning:
        "Synthetic scope resolution uses both retained history pages for this exact assigned Vendor.",
    },
    progress: {
      scopeExhausted: exhausted,
      evidenceIds: [
        from("current-page", "evidenceId"),
        from("older-page", "evidenceId"),
      ],
      gaps: exhausted ? [] : ["Older source coverage remains unverified."],
    },
    detail: "Synthetic scope resolution",
  });
}

async function progress(
  runId: typeof schema.run.$inferSelect.id,
  detail: string,
) {
  const eventId = crypto.randomUUID();
  const result = await updateAgentProgress(getFixtureDb(), {
    runId,
    eventId,
    phase: "research",
    detail,
  });
  expect(result.recorded).toBe(true);
  return eventId;
}

async function inputs(
  page: Page,
  vendor: Pick<typeof schema.vendor.$inferSelect, "id" | "shortcode">,
) {
  await page.getByText("Restart inputs", { exact: true }).click();
  const saved = page.getByLabel("Restart inputs JSON");
  await expect(saved).toBeVisible();
  await expect(saved).toContainText("vendor_purchases");
  await expect(saved).toContainText(vendor.shortcode);
  await expect(saved).not.toContainText(vendor.id);
}

test("shows a generic Vendor research dispatch's original saved failure diagnostics", async ({
  page,
}) => {
  const name = `Synthetic failed research ${Date.now()}`;
  const member = await ensureMemberParty(page, name);
  const vendor = await insertWithShortcode(getFixtureDb(), "vendor", { name });
  const { run } = await admitVendorResearch(
    getFixtureDb(),
    member.id,
    vendor.shortcode,
  );
  if (!run.dispatchEventId)
    throw new Error("Research dispatch generation missing.");
  const reason =
    "AI Gateway request failed (model: synthetic-model, provider: synthetic-provider, operation: dispatch): Synthetic upstream failure\n    at provider (synthetic-provider.ts:12:3)\nSentry event: ffffffffffffffffffffffffffffffff";
  await expect(
    dispatchRunEvent(
      getFixtureDb(),
      {
        send: async () => {
          throw new Error(reason);
        },
      },
      {
        version: 1,
        type: "start_or_resume",
        runId: run.id,
        purpose: "account_sync",
        eventId: run.dispatchEventId,
      },
    ),
  ).rejects.toThrow(reason);
  const failed = await readRun(run.shortcode);
  expect(failed).toMatchObject({
    status: "dispatch_failed",
    failureCode: "dispatch_failed",
    dispatchError: reason,
  });
  await gotoAuthenticatedPage(
    page,
    `/runs/${run.shortcode}`,
    page.getByText("Failure details"),
  );
  const preview = page.getByTestId("run-failure-preview");
  await expect(preview).toContainText("model: synthetic-model");
  await expect(preview).toHaveCSS("-webkit-line-clamp", "2");
  await expect(
    page.getByRole("link", { name: "View in Sentry" }).first(),
  ).toHaveAttribute("href", /query=ffffffffffffffffffffffffffffffff/u);
  await expect(page.getByText("synthetic-provider.ts:12:3")).toHaveCount(0);
  await expect(page.getByText("Show full failure")).toHaveCount(0);
  await expect(page.getByText("Technical details")).toHaveCount(0);
  await page.reload();
  await expect(preview).toContainText("Synthetic upstream failure");
  expect((await readRun(run.shortcode)).dispatchError).toBe(reason);
});

test("updates generic research progress live and retains a supported completed scope summary", async ({
  page,
  e2eRuntime,
}) => {
  const agent = await configure(
    e2eRuntime,
    [
      ...investigation,
      { gate: "older-page-pending" },
      call("older-page", "web_read", {
        workRef: from("scope", "work.workRef"),
        url: olderURL,
      }),
      { gate: "scope-resolution-pending" },
      resolution(true),
    ],
    true,
  );
  const { run, vendor } = await launch(
    page,
    `Synthetic complete research ${Date.now()}`,
  );
  await expect.poll(() => agent.emitted()).toContain("gate:older-page-pending");
  await progress(
    run.id,
    "Synthetic current history retained; investigating older evidence.",
  );
  await expect(
    page
      .getByText(
        /Synthetic current history retained; investigating older evidence/u,
      )
      .first(),
  ).toBeVisible();
  await inputs(page, vendor);
  expect((await records(run.id)).targets).toMatchObject([{ state: "pending" }]);
  await agent.release("older-page-pending");
  await expect
    .poll(() => agent.emitted())
    .toContain("gate:scope-resolution-pending");
  await progress(
    run.id,
    "Synthetic older history retained; checking complete scope support.",
  );
  await expect(
    page
      .getByText(
        /Synthetic older history retained; checking complete scope support/u,
      )
      .first(),
  ).toBeVisible();
  expect((await records(run.id)).evidence).toHaveLength(2);
  expect((await readRun(run.shortcode)).status).toBe("running");
  await agent.release("scope-resolution-pending");
  await expect
    .poll(async () => (await readRun(run.shortcode)).status)
    .toBe("completed");
  await expect
    .poll(async () =>
      (await records(run.id)).operations.some(
        (operation) =>
          operation.kind === "research_resolve_import" &&
          operation.state === "completed",
      ),
    )
    .toBe(true);
  const saved = await records(run.id);
  expect(saved.targets).toMatchObject([
    { state: "completed", outcome: "verified" },
  ]);
  expect(
    saved.evidence.every(
      (original) => original.targetId === saved.targets[0]?.id,
    ),
  ).toBe(true);
  await expect(
    page
      .getByText("Verified", { exact: true })
      .first()
      .locator("..")
      .getByText("1", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByText("To go", { exact: true })
      .first()
      .locator("..")
      .getByText("0", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByText(
        /Synthetic older history retained; checking complete scope support/u,
      )
      .first(),
  ).toBeVisible();
  await inputs(page, vendor);
  await retainedRecords(run.id, saved);
  expect(await agent.violations()).toEqual([]);
});

test("retries failed research as a new Run with exact lineage, preserves the prior results and cancels the successor", async ({
  page,
  e2eRuntime,
}) => {
  const agent = await configure(
    e2eRuntime,
    [
      ...investigation,
      { gate: "research-in-flight" },
      call("late-next", "work_next"),
    ],
    false,
  );
  const { run } = await launch(page, `Synthetic retry research ${Date.now()}`);
  await expect.poll(() => agent.emitted()).toContain("gate:research-in-flight");
  const reason = "Synthetic retained provider failure before scope completion.";
  await progress(run.id, reason);
  expect(
    await markRunFailed(getFixtureDb(), {
      runId: run.id,
      dispatchEventId: run.dispatchEventId!,
      failureCode: "agent_failed",
      detail: reason,
    }),
  ).toMatchObject({ failed: true });
  const failed = await readRun(run.shortcode);
  const prior = await records(run.id);
  expect(prior.evidence).toHaveLength(1);
  expect(prior.operations.length).toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByText(reason, { exact: false }).first()).toBeVisible();
  await page
    .getByRole("button", { name: "Retry unresolved work", exact: true })
    .click();
  await expect(page).not.toHaveURL(new RegExp(`/runs/${run.shortcode}$`, "u"));
  const nextCode = page.url().split("/").at(-1);
  if (!nextCode) throw new Error("Retry omitted its successor Run.");
  const successor = await readRun(nextCode);
  expect(successor.id).not.toBe(run.id);
  expect(successor).toMatchObject({
    predecessorRunId: run.id,
    parentRunId: failed.parentRunId,
    cause: "retry",
    attempt: failed.attempt === null ? null : failed.attempt + 1,
    input: run.input,
    ledgerPartyId: run.ledgerPartyId,
  });
  await expect(
    page.getByRole("link", { name: `Retry of ${run.shortcode}`, exact: true }),
  ).toHaveAttribute("href", `/runs/${run.shortcode}`);
  await expect
    .poll(async () => (await records(successor.id)).evidence.length)
    .toBe(1);
  const successorBeforeCancel = await records(successor.id);
  expect(
    successorBeforeCancel.evidence.every((original) =>
      successorBeforeCancel.targets.some(
        (target) => target.id === original.targetId,
      ),
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Stop run", exact: true }).click();
  await expect
    .poll(async () => (await readRun(nextCode)).failureCode)
    .toBe("user_cancelled");
  const cancelled = await readRun(nextCode);
  expect(cancelled.status).toBe("failed");
  expect(cancelled.endedAt).not.toBeNull();
  await agent.release("research-in-flight");
  await expect(
    page.getByRole("button", { name: "Retry unresolved work", exact: true }),
  ).toBeVisible();
  await page.reload();
  expect(await readRun(run.shortcode)).toEqual(failed);
  await retainedRecords(run.id, prior);
  expect((await readRun(nextCode)).failureCode).toBe("user_cancelled");
  expect((await records(successor.id)).evidence).toEqual(
    successorBeforeCancel.evidence,
  );
});

test("keeps one admitted scope live through multiple retained pages and reports unresolved coverage without completed success", async ({
  page,
  e2eRuntime,
}) => {
  const agent = await configure(
    e2eRuntime,
    [
      ...investigation,
      { gate: "older-unverified" },
      call("older-page", "web_read", {
        workRef: from("scope", "work.workRef"),
        url: olderURL,
      }),
      { gate: "coverage-unverified" },
      resolution(false),
    ],
    false,
  );
  const { run, vendor } = await launch(
    page,
    `Synthetic unresolved research ${Date.now()}`,
  );
  await expect.poll(() => agent.emitted()).toContain("gate:older-unverified");
  await progress(
    run.id,
    "Synthetic history continues to an older retained page.",
  );
  await expect(
    page
      .getByText(/Synthetic history continues to an older retained page/u)
      .first(),
  ).toBeVisible();
  await inputs(page, vendor);
  await agent.release("older-unverified");
  await expect
    .poll(() => agent.emitted())
    .toContain("gate:coverage-unverified");
  const read = await records(run.id);
  expect(read.evidence).toHaveLength(2);
  expect(read.targets).toMatchObject([{ state: "pending" }]);
  expect((await readRun(run.shortcode)).status).toBe("running");
  expect((await readRun(run.shortcode)).input).toEqual(run.input);
  await agent.release("coverage-unverified");
  await expect
    .poll(async () => (await readRun(run.shortcode)).status)
    .toBe("needs_review");
  await expect
    .poll(async () =>
      (await records(run.id)).operations.some(
        (operation) =>
          operation.kind === "research_resolve_import" &&
          operation.state === "completed",
      ),
    )
    .toBe(true);
  const reviewed = await records(run.id);
  expect(reviewed.targets).toMatchObject([
    {
      state: "unresolved",
      outcome: "researched_with_gaps",
      warning: expect.stringContaining(
        "Older source coverage remains unverified.",
      ),
    },
  ]);
  await expect(
    page
      .getByText("Older source coverage remains unverified.", { exact: false })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByText("Purchase import complete", { exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await inputs(page, vendor);
  expect((await readRun(run.shortcode)).status).toBe("needs_review");
  await retainedRecords(run.id, reviewed);
  expect(await agent.violations()).toEqual([]);
});
