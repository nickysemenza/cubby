import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { selectedJourneys } from "../../tooling/tester-army/journey";
import { runJourney } from "../../tooling/tester-army/journey-run";
import { journeys } from "../../tooling/tester-army/journeys";
import { readBrowserCookies } from "../../tooling/tester-army/scenario";

for (const journey of selectedJourneys(journeys))
  test(journey.title, async ({ app, agent, screen, browser }) => {
    await browser.setCookies(readBrowserCookies());
    await runJourney(journey, "web", {
      agent,
      expectText: async (text, visible) => {
        const target = screen.getByText(text, { exact: false }).first();
        if (visible) await expect(target).toBeVisible();
        else await expect(target).toBeHidden();
      },
      open: ({ entity, web }) => app.open(web ?? `/${entity}`),
    });
  });
