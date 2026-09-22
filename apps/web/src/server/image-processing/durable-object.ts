import type { WebSocket as CfWebSocket } from "@cloudflare/workers-types";
import {
  imageProcessingClientMessage,
  imageProcessingServerMessage,
  type ImageProcessingCommand,
  imageProcessingCapabilities,
} from "@cubby/schemas/image-processing";
import { backgroundTaskMessageSchema } from "@cubby/schemas/queue-messages";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { db, withRequestDbClient } from "~/server/db";
import { upsertDeviceFromHello } from "~/server/repo/device-participation";
import {
  assignImageProcessingExecutor,
  isAssignedImageProcessingDevice,
} from "~/server/repo/image-processing-history";

import type { ImageProcessingCompanionRpc } from "./contracts";
import { safeImageProcessingError } from "./safe-error";

declare const WebSocketPair: { new (): { 0: WebSocket; 1: CfWebSocket } };

const socketAttachment = z.object({
  protocolVersion: z.literal(1),
  userId: z.string().min(1),
  deviceId: z.uuid().optional(),
  connectionId: z.uuid().optional(),
  appVersion: z.string().optional(),
  osVersion: z.string().optional(),
  platform: z.enum(["macos", "ios"]),
  capabilities: imageProcessingCapabilities,
  // Device.automaticWork && !Device.remotePaused, cached from the row a
  // hello upserted/read. Absent (legacy pre-hello attachment) reads as
  // non-participating below, never as an implicit opt-in.
  participating: z.boolean().optional(),
});
type SocketAttachment = z.infer<typeof socketAttachment>;

/** Set by the hello for the socket's lifetime. A socket that never said hello
 * reads as non-participating, never as an implicit opt-in. A flip of
 * `automaticWork`/`remotePaused` after hello is caught by
 * `assignImageProcessingExecutor`'s authoritative re-read; the cache only
 * keeps opted-out devices out of the dispatch loop. */
const isParticipating = (attachment: SocketAttachment): boolean =>
  attachment.participating === true;

function decode(message: string | ArrayBuffer) {
  try {
    const text =
      message instanceof ArrayBuffer
        ? new TextDecoder().decode(new Uint8Array(message))
        : message;
    return imageProcessingClientMessage.safeParse(JSON.parse(text));
  } catch {
    return imageProcessingClientMessage.safeParse(null);
  }
}

/**
 * Connection/replay transport only. Postgres job state and leases decide what
 * is executable; this object does not persist an independent command queue.
 */
export class ImageProcessingDurableObject
  extends DurableObject<Env>
  implements ImageProcessingCompanionRpc
{
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket upgrade required", { status: 426 });
    const userId = request.headers.get("x-cubby-user-id");
    if (!userId)
      return new Response("Authenticated companion required", { status: 403 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    // Hello replaces this placeholder after the parsed capability report.
    server.serializeAttachment({
      protocolVersion: 1,
      userId,
      connectionId: crypto.randomUUID(),
      platform: "ios",
      capabilities: {
        visionSubjectLift: { available: false },
        actualImageDescription: { available: false },
        foreground: false,
      },
    } satisfies SocketAttachment);
    // SAFETY: Cloudflare's worker runtime accepts the documented webSocket
    // response extension, which the platform library omits from ResponseInit.
    const init = {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket };
    return new Response(null, init);
  }

  async dispatch(command: ImageProcessingCommand): Promise<boolean> {
    const compatible = this.ctx
      .getWebSockets()
      .flatMap((socket) => {
        const attachment = socketAttachment.safeParse(
          socket.deserializeAttachment(),
        );
        if (!attachment.success) return [];
        const capable =
          command.kind === "subject_lift"
            ? attachment.data.capabilities.visionSubjectLift.available
            : attachment.data.capabilities.actualImageDescription.available;
        // iOS processing is only valid while foregrounded. macOS continuously
        // advertises foreground=true for its resident companion worker.
        return capable &&
          attachment.data.deviceId &&
          attachment.data.capabilities.foreground &&
          isParticipating(attachment.data)
          ? [{ socket, attachment: attachment.data }]
          : [];
      })
      .sort(
        (a, b) =>
          Number(b.attachment.platform === "macos") -
          Number(a.attachment.platform === "macos"),
      );
    const target = compatible[0];
    if (!target) return false;
    const assigned = await withRequestDbClient(
      this.env.HYPERDRIVE.connectionString,
      () =>
        assignImageProcessingExecutor(db, {
          jobId: command.jobId,
          attemptId: command.attemptId,
          executor: {
            kind: "device",
            deviceId: target.attachment.deviceId ?? null,
            name: target.attachment.platform === "macos" ? "Mac" : "iOS device",
            platform: target.attachment.platform,
            appVersion: target.attachment.appVersion ?? null,
            osVersion: target.attachment.osVersion ?? null,
          },
          userId: target.attachment.userId,
          connectionId: target.attachment.connectionId,
        }),
    );
    if (!assigned) return false;
    target.socket.send(
      JSON.stringify(
        imageProcessingServerMessage.parse({
          protocolVersion: 1,
          type: "command",
          command,
        }),
      ),
    );
    return true;
  }

  async webSocketMessage(socket: CfWebSocket, message: string | ArrayBuffer) {
    const parsed = decode(message);
    if (!parsed.success) {
      socket.close(1008, "Invalid image-processing protocol");
      return;
    }
    if (parsed.data.type === "hello") {
      const previous = socketAttachment.parse(socket.deserializeAttachment());
      const hello = parsed.data;
      const suggestedName =
        hello.deviceName ?? (hello.platform === "macos" ? "Mac" : "iOS device");
      // The `Device` row is the durable half of participation — the
      // installationId (this hello's `deviceId`) is its unique key. The name
      // is a creation hint; a later hello refreshes versions and liveness.
      const { automaticWork, remotePaused } = await withRequestDbClient(
        this.env.HYPERDRIVE.connectionString,
        () =>
          upsertDeviceFromHello(db, {
            installationId: hello.deviceId,
            name: suggestedName,
            platform: hello.platform,
            appVersion: hello.appVersion,
            osVersion: hello.osVersion ?? null,
            automaticWork: hello.participation.automaticWork,
          }),
      );
      socket.serializeAttachment({
        protocolVersion: 1,
        userId: previous.userId,
        connectionId: previous.connectionId ?? crypto.randomUUID(),
        deviceId: hello.deviceId,
        appVersion: hello.appVersion,
        osVersion: hello.osVersion,
        platform: hello.platform,
        capabilities: hello.capabilities,
        participating: automaticWork && !remotePaused,
      } satisfies SocketAttachment);
      socket.send(
        JSON.stringify(
          imageProcessingServerMessage.parse({
            protocolVersion: 1,
            type: "helloAck",
            remotePaused,
          }),
        ),
      );
      return;
    }
    const connection = socketAttachment.parse(socket.deserializeAttachment());
    const result = parsed.data.result;
    if (result.outcome.status === "failed")
      result.outcome.reason = safeImageProcessingError(
        new Error(result.outcome.reason),
      );
    const deviceId = connection.deviceId;
    if (
      !deviceId ||
      !(await withRequestDbClient(this.env.HYPERDRIVE.connectionString, () =>
        isAssignedImageProcessingDevice(db, {
          jobId: result.jobId,
          attemptId: result.attemptId,
          deviceId,
          userId: connection.userId,
        }),
      ))
    ) {
      // A deleted/legacy attempt can remain in an older companion outbox. Drop
      // it without adopting anything, but acknowledge so it cannot replay forever.
      socket.send(
        JSON.stringify(
          imageProcessingServerMessage.parse({
            protocolVersion: 1,
            type: "acknowledge",
            jobId: result.jobId,
            attemptId: result.attemptId,
          }),
        ),
      );
      return;
    }
    await this.env.BACKGROUND_QUEUE.send(
      backgroundTaskMessageSchema.parse({
        version: 2,
        queueType: "background",
        task: {
          kind: "image-processing.result",
          requestedAt: new Date().toISOString(),
          result: parsed.data.result,
        },
      }),
    );
    socket.send(
      JSON.stringify(
        imageProcessingServerMessage.parse({
          protocolVersion: 1,
          type: "acknowledge",
          jobId: parsed.data.result.jobId,
          attemptId: parsed.data.result.attemptId,
        }),
      ),
    );
  }

  webSocketError(_socket: CfWebSocket, error: Error): void {
    console.error("image-processing.websocket", error);
  }
}
