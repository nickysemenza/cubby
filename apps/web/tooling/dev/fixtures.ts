import { z } from "zod";

import { ensureDevUser, seedFixturePack } from "./fixture-pack";

export const LOCAL_FIXTURE_PACKS = [
  "core",
  "recipes",
  "images",
  "purchase",
  "garden",
  "calendar",
  "problems",
  "performance",
] as const;
export const devFixturePackSchema = z.enum(LOCAL_FIXTURE_PACKS);
export type LocalFixturePack = (typeof LOCAL_FIXTURE_PACKS)[number];

/** Seed an opt-in pack from Node, forwarding publications to the running Worker. The core corpus
 * seeds inside the dev Worker through `POST /__dev/seed`. */
export async function seedDevDatabase(options: {
  databaseUrl: string;
  baseURL: string;
  pack: Exclude<LocalFixturePack, "core">;
}): Promise<void> {
  const base = new URL(options.baseURL);
  if (!["localhost", "127.0.0.1"].includes(base.hostname)) {
    throw new Error(
      "Local fixtures require an already-running localhost auth runtime",
    );
  }
  await seedFixturePack(options.databaseUrl, options.pack, async (pool) => {
    const { buildScenarioDatabase } = await import("../scenarios/context");
    const { installScenarioBackgroundQueue } =
      await import("../scenarios/background-queue");
    installScenarioBackgroundQueue(
      buildScenarioDatabase(pool),
      options.baseURL,
    );
    const userId = await ensureDevUser((path, body) =>
      fetch(new URL(path, options.baseURL), {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base.origin },
        body: JSON.stringify(body),
      }),
    );
    const { seedLocalFixturePack } = await import("./scenarios");
    await seedLocalFixturePack(pool, userId, options.pack, options.baseURL);
  });
}
