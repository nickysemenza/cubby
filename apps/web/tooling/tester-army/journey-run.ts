import {
  assertDatabase,
  loadJourneyIds,
  stepGoal,
  type Engine,
  type Journey,
} from "./journey";

type Fixtures = {
  /** Opens a web path or an iOS deep link (or just launches the app when undefined). */
  open: (target: {
    entity?: string;
    web?: string;
    ios?: string;
  }) => Promise<void>;
  agent: { act(goal: string): Promise<void | object> };
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
  await fixtures.open({ entity, ...journey.open?.(ids) });
  for (const step of journey.steps) {
    await fixtures.agent.act(stepGoal(step, engine));
    await expectTexts(fixtures, step.check?.visible?.(ids) ?? [], true);
    if (step.check?.db)
      await assertDatabase(journey, step.check.db, ids, false);
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
