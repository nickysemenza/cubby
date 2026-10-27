import { appendFile } from "node:fs/promises";
import { scrubCredentialValues } from "@cubby/worker-tracing/scrub-error-message";
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
  const inspectResponse = async (provider: string, response: Response) => {
    if (!response.ok) {
      // The executor wraps provider errors; retain the upstream diagnostic with evidence.
      const diagnostic = {
        timestamp: new Date().toISOString(),
        provider,
        status: response.status,
        requestId: response.headers.get("cf-ray"),
        body: scrubCredentialValues(
          (await response.clone().text()).replaceAll(token, "[redacted]"),
        ),
      };
      console.error("Tester Army provider failed", diagnostic);
      try {
        await appendFile(
          new URL(
            "../../artifacts/tester-army/provider-errors.jsonl",
            import.meta.url,
          ),
          `${JSON.stringify(diagnostic)}\n`,
          { mode: 0o600 },
        );
      } catch (error) {
        console.error(
          "Could not retain provider diagnostic",
          scrubCredentialValues(
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
    return response;
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
      const response = await inspectResponse(
        "Jev",
        await fetch(upstream.url, upstream.init),
      );
      if (!response.ok) return response;
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
    fetch: async (input, init) =>
      inspectResponse("text companion", await fetch(input, init)),
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
