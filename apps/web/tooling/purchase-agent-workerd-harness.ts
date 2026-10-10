/* eslint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/no-unknown-returns -- The scenario adapter forwards queue events, browser outcomes, and peer fixtures unchanged as JSON. */
import type { researchAssessment } from "@cubby/schemas/research-assessment";
import type { RunPurpose } from "@cubby/schemas/run-fields";
import type { TestHarness } from "wrangler";
import { z } from "zod";
import type { Fixture as GatewayFixture } from "../tests/e2e/harness-services/purchase-import-test-gateway";

import type { ScriptStep } from "./purchase-agent-script";

/** One scripted purchase-agent scenario: the coordinator's steps and the gateway's outputs. */
export type ScriptedScenario = {
  steps: ScriptStep[];
  expectedInference?: { model: string; effort: string };
  purposeSteps?: Partial<Record<RunPurpose, ScriptStep[]>>;
  sourceSteps?: Array<{
    call: string;
    path: string;
    includes: string;
    steps: ScriptStep[];
  }>;
  assessments?: Array<{
    match: string;
    output: z.input<typeof researchAssessment>;
  }>;
  extractions?: Array<{ match: string; output: unknown }>;
  audit?: unknown;
  decisions?: GatewayFixture["decisions"];
};

type JsonPost = {
  method: "POST";
  headers: Record<string, string>;
  body: string;
};
type Sender = (
  path: string,
  init: JsonPost,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Drive a listening purchase-agent harness: load a scenario into its
 * deterministic peers, deliver queue events, and read what the agent did.
 */
export function scenarioControls(harness: TestHarness) {
  const model = harness.getWorker("cubby-test-model");
  const gateway = harness.getWorker("cubby-test-gateway");
  const queue = harness.getWorker("cubby-queue-producer");
  const post = async (send: Sender, path: string, body: object) => {
    const response = await send(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(`${path} ${response.status}: ${await response.text()}`);
  };
  const toModel: Sender = (path, init) => model.fetch(path, init);
  const toGateway: Sender = (path, init) => gateway.fetch(path, init);
  const toQueue: Sender = (path, init) =>
    queue.fetch(new URL(path, "https://queue.test"), init);
  const readJson = async <T>(
    schema: z.ZodType<T>,
    send: () => Promise<{ json(): Promise<unknown> }>,
  ): Promise<T> => schema.parse(await (await send()).json());
  return {
    /** Replace the scripted model's steps and the gateway's outputs. */
    configure: async (scenario: ScriptedScenario) => {
      await post(toModel, "https://model.test/configure", {
        steps: scenario.steps,
        expectedInference: scenario.expectedInference,
        purposeSteps: scenario.purposeSteps,
        sourceSteps: scenario.sourceSteps,
      });
      const gatewayFixture: Pick<
        ScriptedScenario,
        "extractions" | "assessments" | "audit" | "decisions"
      > = {
        extractions: scenario.extractions ?? [],
        assessments: scenario.assessments ?? [],
        decisions: scenario.decisions,
      };
      if (scenario.audit) gatewayFixture.audit = scenario.audit;
      await post(toGateway, "https://gateway.test/configure", gatewayFixture);
    },
    /** Let the model answer past a `{ gate }` step. */
    release: (gate: string) =>
      post(toModel, "https://model.test/release", { gate }),
    /** Deliver one purchase-agent queue event, as the web Worker would. */
    dispatch: (event: Record<string, unknown>) =>
      post(toQueue, "/dispatch", event),
    /** Connect a simulated Mac browser that answers commands by URL. */
    connectBrowser: (input: {
      vendorAccountId: string;
      ledgerPartyId: string;
      userId: string;
      outcomes?: Record<string, unknown>;
      delayMs?: number;
    }) => post(toQueue, "/browser-connect", input),
    violations: async () =>
      readJson(z.array(z.string()), () =>
        model.fetch("https://model.test/violations"),
      ),
    /** Each step the scripted model emitted: what the agent actually executed. */
    emitted: async () =>
      readJson(z.array(z.string()), () =>
        model.fetch("https://model.test/emitted"),
      ),
    gatewayCalls: async () =>
      readJson(
        z.array(
          z.object({ feature: z.string(), matched: z.string().nullable() }),
        ),
        () => gateway.fetch("https://gateway.test/calls"),
      ),
  };
}

export type ScenarioControls = ReturnType<typeof scenarioControls>;
