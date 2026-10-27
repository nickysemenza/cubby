import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { createOpenAI } from "@ai-sdk/openai";
import { decisionExecutor } from "@e2e-dev/decision";
import { z } from "zod";
import {
  CF_ACCOUNT_ID,
  CUBBY_AI_GATEWAY_ID,
  testAiGatewayEnvironment,
} from "@cubby/shared/ai/gateway-metadata";
import {
  gatewayBaseURL,
  workersAiRunRequest,
} from "@cubby/shared/ai/gateway-request";
import { DECISION_MODEL, FAST_MODEL } from "@cubby/shared/ai/models";

/** Jev chooses operations and targets; the companion supplies free-text inputs. */
export function journeyAgent() {
  const token = process.env.TESTER_ARMY_CF_API_TOKEN;
  if (!token)
    throw new Error(
      "Tester Army requires TESTER_ARMY_CF_API_TOKEN; use the journey runner to load the configured gateway credential",
    );
  const metadata = {
    environment: testAiGatewayEnvironment(process.env.CI),
    feature: "tester-army",
    operation: "driver",
  };
  const decision = createTypeSafeAi({
    apiKey: token,
    baseURL: gatewayBaseURL("workers-ai"),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const { model: _model, ...query } = z
        .record(z.string(), z.json())
        .parse(await request.json());
      const upstream = workersAiRunRequest({
        accountId: CF_ACCOUNT_ID,
        token,
        model: DECISION_MODEL,
        input: query,
        signal: request.signal,
        gateway: { id: CUBBY_AI_GATEWAY_ID, metadata, skipCache: true },
      });
      const response = await fetch(upstream.url, upstream.init);
      if (!response.ok) {
        // The executor wraps provider errors; retain the upstream diagnostic in CI.
        console.error("Tester Army decision provider failed", {
          status: response.status,
          requestId: response.headers.get("cf-ray"),
          body: (await response.clone().text()).replaceAll(token, "[redacted]"),
        });
        return response;
      }
      const body: unknown = await response.json();
      const envelope = z.object({ result: z.unknown() }).safeParse(body);
      const payload = envelope.success ? envelope.data.result : body;
      const completed = z
        .object({ state: z.literal("Completed"), result: z.unknown() })
        .safeParse(payload);
      return Response.json(completed.success ? completed.data.result : payload);
    },
  }).decisionModel(DECISION_MODEL);
  const text = createOpenAI({
    apiKey: token,
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1`,
    headers: {
      "cf-aig-authorization": `Bearer ${token}`,
      "cf-aig-metadata": JSON.stringify(metadata),
      "cf-aig-skip-cache": "true",
      "cf-aig-gateway-id": CUBBY_AI_GATEWAY_ID,
    },
  }).responses(`openai/${FAST_MODEL}`);
  return {
    executor: decisionExecutor({
      model: decision,
      textModel: text,
    }),
    maxSteps: 40,
    maxModelCalls: 100,
  };
}
