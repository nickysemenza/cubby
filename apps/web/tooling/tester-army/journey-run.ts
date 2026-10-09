import type { AgentParams } from "e2e";
import {
  assertDatabase,
  assertScreenRead,
  awaitRun,
  loadJourneyIds,
  replayParams,
  stepGoal,
  type Engine,
  type Journey,
  type Json,
  type ScreenRead,
} from "./journey";

type Fixtures = {
  /** Opens a web path or an iOS deep link (or just launches the app when undefined). */
  open: (target: {
    entity?: string;
    web?: string;
    ios?: string;
  }) => Promise<void>;
  agent: {
    act(goal: string, options: { params: AgentParams }): Promise<void | object>;
    extract(
      instruction: string,
      options: { schema: ScreenRead["schema"] },
    ): Promise<Json>;
  };
  /** Web only: fixes the viewport before the journey opens its page. */
  setViewport?: (size: { width: number; height: number }) => Promise<void>;
  /** Reloads the current page so it shows what a live run wrote meanwhile. */
  reload: () => Promise<void>;
  /** Exact-text assertions supplied by the engine's own `expect`/`screen`. */
  expectText: (text: string, visible: boolean) => Promise<void>;
};

async function expectTexts(
  fixtures: Fixtures,
  texts: string[],
  visible: boolean,
) {
  for (const text of texts) await fixtures.expectText(text, visible);
}

async function runJourneyBody(
  journey: Journey,
  engine: Engine,
  fixtures: Fixtures,
) {
  const ids = loadJourneyIds(journey.id);
  const wrong = process.env.TESTER_ARMY_WRONG === "1";
  const entity = journey.start ? ids.get(journey.start) : undefined;
  const params = replayParams(ids);
  if (journey.viewport) await fixtures.setViewport?.(journey.viewport);
  await fixtures.open({ entity, ...journey.open?.(ids) });
  for (const step of journey.steps) {
    if (step.ready) await assertDatabase(journey, [step.ready], ids, false);
    if (step.awaitRun) await awaitRun(journey, step.awaitRun, ids);
    if (step.ready || step.awaitRun) await fixtures.reload();
    await fixtures.agent.act(stepGoal(step, engine), { params });
    await expectTexts(fixtures, step.check?.visible?.(ids) ?? [], true);
    if (step.check?.db)
      await assertDatabase(journey, step.check.db, ids, false);
    if (step.read)
      assertScreenRead(
        journey,
        step.read,
        await fixtures.agent.extract(step.read.instruction, {
          schema: step.read.schema,
        }),
        ids,
        wrong,
      );
  }
  if (journey.awaitRun) {
    await awaitRun(journey, journey.awaitRun, ids);
    await fixtures.reload();
  }
  await expectTexts(fixtures, journey.visible(ids), true);
  await expectTexts(fixtures, journey.absent?.(ids) ?? [], false);
  await assertDatabase(journey, journey.db, ids, wrong);
}

/** Runs one shared journey on whichever engine the caller opened. */
export async function runJourney(
  journey: Journey,
  engine: Engine,
  fixtures: Fixtures,
) {
  try {
    await runJourneyBody(journey, engine, fixtures);
  } finally {
    // The inference gateway rate-limits bursts (seen on a 16-journey run); pace journeys instead of retrying them.
    const ms = Number(process.env.TESTER_ARMY_PACE_MS ?? 20_000);
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
