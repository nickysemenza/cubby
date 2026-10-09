import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { resolveDevProfile } from "../../../../scripts/lib/dev-profile.ts";
import { devSessionSchema, type DevSession } from "../../tooling/dev/state";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

const readinessSchema = z.object({
  devId: z.string(),
  database: z.string().nullable(),
  ready: z.boolean(),
  error: z.string().optional(),
});

/**
 * The persistent `pnpm dev` session this checkout owns, or a refusal naming why
 * it cannot be used. The HMR lane writes straight to the session's database,
 * so every identity the supervisor recorded must agree with the profile this
 * checkout resolves before a test may run.
 */
export function discoverHmrSession() {
  const profile = resolveDevProfile(repoRoot);
  const file = path.join(profile.stateDir, "session.json");
  if (!existsSync(file))
    throw new Error(
      `No development session at ${file}; start pnpm dev in this checkout first`,
    );
  const session: DevSession = devSessionSchema.parse(
    JSON.parse(readFileSync(file, "utf8")),
  );
  const mismatch = [
    session.id !== profile.id && `id ${session.id} != ${profile.id}`,
    session.database !== profile.name &&
      `database ${session.database} != ${profile.name}`,
    session.stateDir !== profile.stateDir &&
      `stateDir ${session.stateDir} != ${profile.stateDir}`,
    new URL(session.origin).hostname !== "localhost" &&
      `origin ${session.origin} is not loopback`,
    session.mode !== "development" && `mode ${session.mode} is not HMR`,
    session.readiness !== "ready" && `readiness ${session.readiness}`,
  ].filter(Boolean);
  if (mismatch.length > 0)
    throw new Error(
      `Development session is not usable for the HMR lane: ${mismatch.join("; ")}`,
    );
  try {
    process.kill(session.supervisorPid, 0);
  } catch {
    throw new Error(
      `Development supervisor ${session.supervisorPid} is not running; restart pnpm dev`,
    );
  }
  return { profile, session };
}

export type HmrSession = ReturnType<typeof discoverHmrSession>;

/** The live Worker must report this checkout's id and database before any write. */
export async function assertHmrRuntimeIdentity({
  profile,
  session,
}: HmrSession) {
  for (const route of ["/__dev/health", "/__dev/ready"] as const) {
    const response = await fetch(new URL(route, session.origin), {
      redirect: "error",
    });
    const body = readinessSchema.parse(await response.json());
    if (body.devId !== profile.id || body.database !== profile.name)
      throw new Error(
        `${route} reports ${body.devId}/${body.database}; expected ${profile.id}/${profile.name}`,
      );
    if (route === "/__dev/ready" && (!response.ok || !body.ready))
      throw new Error(
        `${route} is not ready (${response.status}): ${body.error ?? "fixtures or peers pending"}`,
      );
  }
}
