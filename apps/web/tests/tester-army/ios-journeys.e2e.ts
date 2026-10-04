import { test } from "@e2e-dev/mobile";
import { expect } from "e2e";

import { selectedJourneys } from "../../tooling/tester-army/journey";
import { runJourney } from "../../tooling/tester-army/journey-run";
import { journeys } from "../../tooling/tester-army/journeys";

for (const journey of selectedJourneys(journeys))
  test(journey.title, async ({ app, agent, screen, device }) => {
    await runJourney(journey, "ios", {
      agent,
      expectText: async (text, visible) => {
        const target = screen.getByText(text, { exact: false }).first();
        if (visible) await expect(target).toBeVisible();
        else await expect(target).toBeHidden();
      },
      open: async ({ entity, ios }) => {
        await app.open();
        const link = ios ?? (entity ? `cubby://entity/${entity}` : undefined);
        if (link) await device.openLink(link);
      },
    });
  });
