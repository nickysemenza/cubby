import { importRunPublicId } from "@cubby/schemas/purchase-import";
import { z } from "zod";

import { getBindingFetcher } from "~/server/cf-env";
import {
  loadRunScopeByPublicId,
  recordImportRunControlEvent,
} from "~/server/purchase-import/run-service";
import type {
  AuthenticatedRequestContext,
  CurrentParty,
} from "~/server/request-context";

const ACTIVE_STATUSES = new Set([
  "running",
  "paused_auth",
  "paused_offline",
  "paused_approval",
]);

const allowedSuffix = /^(?:|abort|attachments\/[A-Za-z0-9._~-]+)$/u;

export function purchaseAgentRequestIsWritable(input: {
  method: string;
  status: string;
  suffix: string;
}) {
  return (
    input.method === "GET" ||
    input.method === "HEAD" ||
    input.suffix === "abort" ||
    ACTIVE_STATUSES.has(input.status)
  );
}

export async function proxyPurchaseAgentRequest(input: {
  request: Request;
  publicId: string;
  suffix?: string;
  context: AuthenticatedRequestContext;
  party: CurrentParty;
}) {
  const publicId = importRunPublicId.parse(input.publicId);
  const scope = await loadRunScopeByPublicId(input.context.db, publicId);
  const suffix = input.suffix?.replace(/^\/+|\/+$/gu, "") ?? "";
  if (!allowedSuffix.test(suffix)) {
    return Response.json(
      { error: "Agent resource was not found" },
      { status: 404 },
    );
  }
  if (
    !purchaseAgentRequestIsWritable({
      method: input.request.method,
      status: scope.public.status,
      suffix,
    })
  ) {
    return Response.json(
      { error: "Terminal import runs are view-only" },
      { status: 409 },
    );
  }

  const fetcher = getBindingFetcher("PURCHASE_AGENT");
  if (!fetcher) {
    return Response.json(
      { error: "Purchase Agent conversation service is unavailable" },
      { status: 503 },
    );
  }

  const inbound = new URL(input.request.url);
  const internal = new URL(
    `/internal/agents/purchase-import-run/${encodeURIComponent(scope.public.agentId)}${suffix ? `/${suffix}` : ""}`,
    "https://purchase-agent.internal",
  );
  internal.search = inbound.search;
  const headers = new Headers(input.request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("host");
  headers.set("x-cubby-agent-service", "purchase-import-proxy-v1");
  headers.set("x-cubby-controlling-user", input.context.auth.userId);
  headers.set("x-cubby-controlling-party", input.party.shortcode);

  const response = await fetcher(
    new Request(internal, {
      method: input.request.method,
      headers,
      body:
        input.request.method === "GET" || input.request.method === "HEAD"
          ? undefined
          : input.request.body,
      redirect: "manual",
    }),
  );
  if (response.ok && input.request.method === "POST") {
    await recordImportRunControlEvent(
      input.context.db,
      input.context.actorContext,
      {
        runPublicId: publicId,
        action: suffix === "abort" ? "abort" : "prompt",
      },
    );
  }
  return await redactJsonAgentResponse(response);
}

async function redactJsonAgentResponse(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return redactAgentEventStream(response);
  }
  if (!contentType.includes("application/json")) return response;
  const body = await response.json().catch(() => null);
  const parsed = z.json().safeParse(body);
  if (!parsed.success) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("set-cookie");
  return Response.json(redactAgentValue(parsed.data), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function redactAgentEventStream(response: Response) {
  if (!response.body) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${redactAgentEventLine(line)}\n`));
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending)
          controller.enqueue(encoder.encode(redactAgentEventLine(pending)));
      },
    }),
  );
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("set-cookie");
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function redactAgentEventLine(line: string) {
  if (!line.startsWith("data:")) return line;
  const prefix = line.startsWith("data: ") ? "data: " : "data:";
  const raw = line.slice(prefix.length);
  if (!raw || raw === "[DONE]") return line;
  try {
    return `${prefix}${JSON.stringify(redactAgentValue(z.json().parse(JSON.parse(raw))))}`;
  } catch {
    // Streaming protocol sentinels and partial/non-JSON event data contain no
    // structured tool payload to redact. Never rewrite their wire format.
    return line;
  }
}

const SECRET_KEY = /(?:authorization|cookie|password|secret|token)$/iu;
const BINARY_VALUE = /^(?:data:|[A-Za-z0-9+/]{4096,}={0,2}$)/u;

type AgentJsonValue = z.infer<ReturnType<typeof z.json>>;

function redactAgentValue(value: AgentJsonValue): AgentJsonValue {
  const array = z.array(z.json()).safeParse(value);
  if (array.success) return array.data.map(redactAgentValue);
  const text = z.string().safeParse(value);
  if (text.success) {
    return BINARY_VALUE.test(text.data) ? "[binary omitted]" : text.data;
  }
  const object = z.record(z.string(), z.json()).safeParse(value);
  if (!object.success) return value;
  return Object.fromEntries(
    Object.entries(object.data).map(([key, child]) => [
      key,
      SECRET_KEY.test(key) ? "[redacted]" : redactAgentValue(child),
    ]),
  );
}
