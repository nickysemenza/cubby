import type { ActorContext } from "@cubby/schemas/context";
import type { RunId } from "@cubby/schemas/identifiers";

/**
 * Who an AI call answers to. A call in a member or agent session names its Run. Any
 * other call says whether a member is waiting on it: that decides whether it stops at
 * its window budget (`isAutomaticAiCall`).
 */
export type AiCallOwner =
  | { runId: RunId; interactive?: undefined }
  | { runId?: undefined; interactive: boolean };

/** Nobody is waiting: the call stops at its window budget. */
export const AUTOMATIC_AI_CALL: AiCallOwner = { interactive: false };

/** The session this work already belongs to, else automatic work. */
export const aiRunOwner = (runId: RunId | null | undefined): AiCallOwner =>
  runId ? { runId } : AUTOMATIC_AI_CALL;

/** The session the actor is already in, else a waiting member. The system actor has nobody waiting. */
export const aiCallOwner = (actor: ActorContext): AiCallOwner =>
  actor.runId
    ? { runId: actor.runId }
    : { interactive: actor.channel !== "system" };
