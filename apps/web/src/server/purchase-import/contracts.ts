import {
  browserBridgeRequest,
  type BrowserBridgeRequest,
} from "@cubby/schemas/purchase-import";
import { z } from "zod";

const evidenceReference = z.object({
  id: z.string().min(1).max(500),
  kind: z.enum(["normalized_pdf", "rendered_pdf", "screenshot"]),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  contentType: z.string().min(1).max(200),
});
const pageCapture = z.object({
  sourceURL: z.url(),
  title: z.string().max(500),
  capturedAt: z.iso.datetime(),
  captureVersion: z.number().int().positive(),
  readableText: z.string().max(24 * 1_024),
  links: z
    .array(
      z.object({ id: z.string(), url: z.url(), label: z.string().nullable() }),
    )
    .max(200),
  images: z
    .array(z.object({ url: z.url(), alt: z.string().nullable() }))
    .max(200),
  paymentEvidence: z
    .array(
      z.object({
        methodLabel: z.string().nullable(),
        lastFour: z.string().nullable(),
        amountText: z.string().nullable(),
      }),
    )
    .max(100),
  evidence: z.array(evidenceReference).max(10),
});
const commandOutcome = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    capture: pageCapture.nullable().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    code: z.enum([
      "cancelled",
      "deadline_exceeded",
      "invalid_command",
      "disallowed_url",
      "unknown_link",
      "browser_unavailable",
      "browser_permission_denied",
      "authentication_required",
      "capture_unavailable",
      "upload_failed",
      "execution_failed",
    ]),
    message: z.string().max(2_000),
    retryable: z.boolean(),
  }),
]);
export const browserBridgeResult = z.object({
  commandID: z.uuid(),
  runID: z.string().min(1).max(200),
  completedAt: z.iso.datetime(),
  outcome: commandOutcome,
});
export type BrowserBridgeResult = z.infer<typeof browserBridgeResult>;

const bridgeClientMessage = z.discriminatedUnion("type", [
  z.object({
    version: z.literal(1),
    type: z.literal("hello"),
    deviceID: z.uuid(),
    browser: z.enum(["chrome", "safari"]),
    capabilities: z.object({
      fixedCaptureVersion: z.number().int().positive(),
      enhancedScreenshot: z.boolean(),
      renderedPDF: z.boolean(),
    }),
  }),
  z.object({
    version: z.literal(1),
    type: z.literal("result"),
    result: browserBridgeResult,
  }),
  z.object({
    version: z.literal(1),
    type: z.literal("pong"),
    timestamp: z.iso.datetime(),
  }),
]);

export const decodeBrowserBridgeMessage = (message: string | ArrayBuffer) => {
  try {
    const stringMessage = z.string().safeParse(message);
    const text = stringMessage.success
      ? stringMessage.data
      : new TextDecoder().decode(
          new Uint8Array(z.instanceof(ArrayBuffer).parse(message)),
        );
    return bridgeClientMessage.safeParse(JSON.parse(text));
  } catch {
    return bridgeClientMessage.safeParse(null);
  }
};

export const bridgeServerMessage = z.discriminatedUnion("type", [
  z.object({
    version: z.literal(1),
    type: z.literal("command"),
    command: browserBridgeRequest,
  }),
  z.object({
    version: z.literal(1),
    type: z.literal("acknowledge"),
    commandID: z.uuid(),
  }),
  z.object({
    version: z.literal(1),
    type: z.literal("cancel"),
    commandID: z.uuid(),
  }),
  z.object({
    version: z.literal(1),
    type: z.literal("ping"),
    timestamp: z.iso.datetime(),
  }),
]);

export interface PurchaseImportDurableObjectRpc {
  enqueue(command: BrowserBridgeRequest): Promise<void>;
  result(requestId: string): Promise<BrowserBridgeResult | null>;
  cancel(requestId: string): Promise<void>;
}
