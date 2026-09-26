import { z } from "zod";
import type { DeviceId, RunId, UserId } from "./identifiers";

/**
 * How a write entered the app. Who and what did it are separate columns:
 * `oauthClientId` names the MCP client (Claude, ChatGPT, Codex, Flue),
 * `deviceId` names the Apple install (`X-Cubby-Device`), and `runId` names the
 * Run that grouped the work. `system` is only for work with no user present
 * (crons, retries); anything a member starts is attributed to that member.
 */
export const AUDIT_CHANNELS = [
  "web",
  "api",
  "mcp",
  "caldav",
  "system",
] as const;
export const auditChannelSchema = z.enum(AUDIT_CHANNELS);
export type AuditChannel = z.infer<typeof auditChannelSchema>;

export interface ActorAttribution {
  oauthClientId: string | null;
  deviceId: DeviceId | null;
  runId: RunId | null;
}

export interface ActorContext extends ActorAttribution {
  userId: UserId;
  channel: AuditChannel;
}

export function buildActorContext(
  userId: UserId,
  channel: AuditChannel = "web",
  attribution: Partial<ActorAttribution> = {},
): ActorContext {
  return {
    userId,
    channel,
    oauthClientId: attribution.oauthClientId ?? null,
    deviceId: attribution.deviceId ?? null,
    runId: attribution.runId ?? null,
  };
}

/** The actor with `runId` set, unless an enclosing run already owns the work. */
export function actorInRun(actor: ActorContext, runId: RunId): ActorContext {
  return actor.runId ? actor : { ...actor, runId };
}
