import assert from "node:assert/strict";
import { test as base } from "@e2e-dev/web";
import { expect } from "e2e";
import { z } from "zod";
import { fieldEnvelopeFor, fieldValueOf } from "@cubby/schemas/field-envelope";
import { createPaginatedResponseSchema } from "@cubby/schemas/pagination";
import { withSeededE2ERuntime } from "../e2e/support/seeded-runtime";
import { seedWebJourneyWorld } from "../../tooling/scenarios/web-journeys";
import { seedImportJourneys } from "../../tooling/tester-army/scenarios";
import { seedSimulatorPhotoActor } from "../../tooling/scenarios/simulator";
import { authorizePurchaseAgent } from "~/server/domains/purchase-import/repo/purchase-agent-workerd.fixtures";
import { buildScenarioDatabase } from "../../tooling/scenarios/context";
import {
  AUTHENTICATED_SHELL_READY,
  disableBrowserSentry,
} from "../e2e/support/browser-bootstrap";
import { drainDerivedRefreshFrontier } from "~/server/testing/background-queue";
import { getDb } from "~/server/db/helpers";
import * as tables from "~/server/db/schema";
import { and, eq } from "drizzle-orm";
import type { WorkerdLog } from "../../tooling/e2e-workerd-logs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { entityApi } from "../e2e/support/entity-api";
import { startOperation } from "../e2e/support/start-operation";

/** Public identity routed only to this fixture's local R2 adapter. */
const IMAGE_ORIGIN = "http://cubby-e2e-images.test";

export function readFields(value: unknown, names: string[]) {
  const record = z.record(z.string(), z.unknown()).parse(value);
  return Object.fromEntries(
    names.map((name) => {
      const envelope = fieldEnvelopeFor(value, name);
      if (envelope) return [name, fieldValueOf(envelope)];
      assert(Object.hasOwn(record, name), `Missing public field: ${name}`);
      return [name, record[name]];
    }),
  );
}

function openApi(
  scope: Parameters<Parameters<typeof withSeededE2ERuntime>[1]>[0],
) {
  const { client, runtime, context, userId } = scope;
  const databaseUrl = runtime.databaseUrl;
  const api = entityApi(client);
  return {
    client,
    api,
    async sourceAcceptance(
      emailId: string,
      purchaseId: string,
      checksum: string,
    ) {
      // Attribution is not exposed by the public Email read. Inspect its current
      // typed projection through this runtime's lease, never a household URL.
      z.url().parse(databaseUrl);
      assert(
        new URL(databaseUrl).pathname.startsWith("/integresql_test_"),
        "Source attribution requires the disposable browser database",
      );
      const links = await getDb(context.db)
        .select({
          actor: tables.assessmentEmailLink.decidedByUserId,
          checksum: tables.assessmentEmailLink.evidenceChecksum,
        })
        .from(tables.assessmentEmailLink)
        .innerJoin(
          tables.orderMailEvent,
          eq(tables.orderMailEvent.id, tables.assessmentEmailLink.eventId),
        )
        .innerJoin(
          tables.email,
          eq(tables.email.orderMailId, tables.orderMailEvent.orderMailId),
        )
        .innerJoin(
          tables.purchase,
          eq(tables.purchase.id, tables.assessmentEmailLink.purchaseId),
        )
        .where(
          and(
            eq(tables.email.shortcode, emailId),
            eq(tables.purchase.shortcode, purchaseId),
            eq(tables.assessmentEmailLink.decision, "linked"),
          ),
        );
      return {
        count: links.length,
        attributedToMember: links.every((link) => link.actor === userId),
        sourceMatches: links.every((link) => link.checksum === checksum),
      };
    },
    async operation(name: string, input: unknown) {
      const response = await startOperation(client, name, input);
      assert(
        response.ok(),
        `Operation failed (${name}): ${await response.text()}`,
      );
      return response.body;
    },
    async detail(entity: string, id: string) {
      const response = await api.get(entity, id);
      assert(
        response.ok(),
        `Outcome read failed (${entity}): ${JSON.stringify(response.parsedBody)}`,
      );
      return response.parsedBody;
    },
    async list(entity: string) {
      const response = await api.list(entity, {
        pagination: { pageIndex: 0, pageSize: 100 },
      });
      assert(response.ok(), `Outcome list failed (${entity})`);
      const list = createPaginatedResponseSchema(z.unknown()).parse(
        response.parsedBody,
      );
      assert.equal(
        list.items.length,
        list.meta.totalCount,
        "Outcome reads must not silently truncate fixture records",
      );
      return list.items;
    },
    async fields(entity: string, id: string, names: string[]) {
      const response = await api.get(entity, id);
      assert(response.ok(), `Outcome read failed (${entity})`);
      return readFields(response.parsedBody, names);
    },
  };
}

function journeyTest(imports: boolean) {
  return base.extend<{
    data: Awaited<ReturnType<typeof prepareWorld>> & {
      open(route: string): Promise<void>;
    };
  }>({
    data: async ({ browser, app }, provide) => {
      const started = performance.now();
      const startedAt = new Date().toISOString();
      let origin: string | undefined;
      let phase = "Worker startup";
      let setupMs: number | undefined;
      let journeyMs: number | undefined;
      let logs: WorkerdLog[] = [];
      try {
        await withSeededE2ERuntime(
          {
            parallelIndex: 0,
            profile: imports ? "coupled" : "offline",
            objectStorage: imports ? { publicUrl: IMAGE_ORIGIN } : {},
          },
          async (scope) => {
            origin = scope.runtime.baseURL;
            const originalFetch = globalThis.fetch;
            try {
              if (imports) {
                const storage = new URL(scope.runtime.objectStorageUrl);
                // Only the import world needs a synthetic public identity for real R2 bytes.
                globalThis.fetch = async (input, init) => {
                  const url = new URL(
                    input instanceof Request ? input.url : input,
                  );
                  if (url.origin !== IMAGE_ORIGIN)
                    return originalFetch(input, init);
                  const request = new Request(input, init);
                  url.protocol = storage.protocol;
                  url.host = storage.host;
                  return originalFetch(new Request(url, request));
                };
                await browser.route(`${IMAGE_ORIGIN}/**`, async (route) => {
                  const url = new URL(route.request.url);
                  url.protocol = storage.protocol;
                  url.host = storage.host;
                  await route.continue({ url: url.href });
                });
              }
              phase = "scenario seeding";
              const data = await prepareWorld(scope, imports);
              phase = "browser setup";
              await browser.addInitScript(disableBrowserSentry);
              await browser.setCookies(scope.runtime.storageState.cookies);
              setupMs = performance.now() - started;
              phase = "journey";
              const executionStarted = performance.now();
              try {
                await provide({
                  ...data,
                  open: async (route: string) => {
                    await app.open(new URL(route, scope.runtime.baseURL).href);
                    await expect(
                      browser.locator(AUTHENTICATED_SHELL_READY),
                    ).toBeVisible();
                  },
                });
                await app.screenshot("outcome");
              } finally {
                journeyMs = performance.now() - executionStarted;
              }
            } finally {
              logs = scope.runtime.getLogs().slice(-150);
              globalThis.fetch = originalFetch;
            }
          },
        );
      } finally {
        // Diagnostic I/O must never replace the original fixture or test failure.
        try {
          const output = path.resolve(
            import.meta.dirname,
            "../../artifacts/tester-army/fixtures",
          );
          await mkdir(output, { recursive: true });
          await writeFile(
            path.join(output, `${crypto.randomUUID()}.json`),
            JSON.stringify({
              phase,
              startedAt,
              origin,
              setupMs: setupMs ?? performance.now() - started,
              journeyMs: journeyMs ?? null,
              logs,
            }),
          );
        } catch (error) {
          console.error("Could not retain journey fixture diagnostics:", error);
        }
      }
    },
  });
}

async function prepareWorld(
  scope: Parameters<Parameters<typeof withSeededE2ERuntime>[1]>[0],
  imports: boolean,
) {
  await seedSimulatorPhotoActor(scope.pool, scope.userId);
  const world = await seedWebJourneyWorld(scope.context);
  let scenarios: Awaited<ReturnType<typeof seedImportJourneys>> | undefined;
  if (imports) {
    await authorizePurchaseAgent(
      buildScenarioDatabase(scope.pool),
      scope.userId,
    );
    scenarios = await seedImportJourneys(scope);
  }
  await drainDerivedRefreshFrontier(scope.context.db);
  return {
    ...openApi(scope),
    world,
    scenarios() {
      assert(scenarios, "Import scenarios require the coupled fixture");
      return scenarios;
    },
  };
}

export const test = journeyTest(false);
export const importTest = journeyTest(true);

/** A deliberately wrong expectation must fail through the same independent oracle. */
type ExpectedOutcome = Record<string, z.core.util.JSONType>;
function corrupt(value: z.core.util.JSONType): z.core.util.JSONType {
  if (value === null) return "deliberately-wrong";
  if (typeof value === "string") return `${value} deliberately wrong`;
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  if (Array.isArray(value)) {
    const [first, ...rest] = value;
    return first === undefined
      ? ["deliberately-wrong"]
      : [corrupt(first), ...rest];
  }
  const first = Object.keys(value)[0];
  if (!first) throw new Error("An outcome needs a meaningful expected value");
  const selected = value[first];
  if (selected === undefined)
    throw new Error("Expected outcomes must contain JSON values");
  return { ...value, [first]: corrupt(selected) };
}
export function outcome(actual: unknown, expected: ExpectedOutcome) {
  const wrong = z.record(z.string(), z.json()).parse(corrupt(expected));
  expect(actual).toMatchObject(
    process.env.TESTER_ARMY_WRONG === "1" ? wrong : expected,
  );
  assert.throws(() => assert.partialDeepStrictEqual(actual, wrong));
}
