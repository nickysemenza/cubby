import scriptedGateway from "../tests/e2e/harness-services/purchase-import-test-gateway";
import { mailEvalOrderId } from "./purchase-mail-eval.fixtures";
import researchEvalPeer from "./research-eval-peer";

// All Responses calls, including source-support assessment, use the real
// subscription peer. Only the measured closed-set Jev seam is scripted.
export default {
  async fetch(
    request: Request,
    env: Parameters<typeof researchEvalPeer.fetch>[1],
    ctx: Parameters<typeof researchEvalPeer.fetch>[2],
  ): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/configure") {
      await scriptedGateway.fetch(
        new Request("https://gateway.test/configure", {
          method: "POST",
          body: JSON.stringify({
            extractions: [],
            assessments: [],
            decisions: [
              {
                feature: "mailbox-triage",
                match: mailEvalOrderId,
                label: "related",
              },
            ],
          }),
        }),
      );
    }
    if (pathname === "/triage-calls")
      return scriptedGateway.fetch(new Request("https://gateway.test/calls"));
    if (pathname === "/workers-ai/run/typesafe/jev")
      return scriptedGateway.fetch(request);
    return researchEvalPeer.fetch(request, env, ctx);
  },
};
