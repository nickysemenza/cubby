import type { DurableObjectState } from "@cloudflare/workers-types";
import type { ChatGptAuthorization } from "@cubby/schemas/chatgpt";
import type { gatewayQuery } from "@cubby/shared/ai-gateway-request";
import { DurableObject } from "cloudflare:workers";

import { ChatGptInferenceRequests, type ChatGptInferenceOptions } from "./rpc";
import { ChatGptSession } from "./session";

export class ChatGptPlanDurableObject extends DurableObject<Env> {
  private readonly session: ChatGptSession;
  private readonly requests: ChatGptInferenceRequests;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.session = new ChatGptSession({
      get: (key) => ctx.storage.get(key),
      put: (key, value) => ctx.storage.put(key, value),
      delete: (key) => ctx.storage.delete(key),
    });
    this.requests = new ChatGptInferenceRequests((body, model, signal) =>
      this.session.infer(body, model, signal),
    );
  }

  status() {
    return this.session.status();
  }
  authorizationHost() {
    return this.session.authorizationHost();
  }
  // `connect` is reserved by the Durable Object stub's socket API.
  authorizePlan(input: ChatGptAuthorization) {
    return this.session.connect(input);
  }
  models() {
    return this.session.models();
  }
  disconnect() {
    return this.session.disconnect();
  }
  infer(
    body: Awaited<ReturnType<typeof gatewayQuery>>,
    model: string,
    options: ChatGptInferenceOptions,
  ) {
    return this.requests.infer(body, model, options);
  }
  async cancel(requestId: string) {
    this.requests.cancel(requestId);
  }
}
