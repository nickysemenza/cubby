import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { selectedJourneys } from "../../tooling/tester-army/journey";
import { runJourney } from "../../tooling/tester-army/journey-run";
import { journeys } from "../../tooling/tester-army/journeys";
import { readBrowserCookies } from "../../tooling/tester-army/scenario";

for (const journey of selectedJourneys(journeys, "web"))
  test(
    journey.title,
    { timeout: journey.timeoutMs, agentContext: journey.context },
    async ({ app, agent, screen, browser }) => {
      await browser.setCookies(readBrowserCookies());
      // The semantic decision table omits disabled controls. Streamed SSR
      // buttons stay disabled until their own React boundary hydrates.
      const ready = () =>
        expect(browser.locator("[data-hydrating]")).toHaveCount(0);
      await runJourney(journey, "web", {
        agent,
        expectText: async (text, visible) => {
          const target = screen.getByText(text, { exact: false }).first();
          if (visible) await expect(target).toBeVisible();
          else await expect(target).toBeHidden();
        },
        open: async ({ entity, web }) => {
          await app.open(web ?? `/${entity}`);
          await ready();
        },
        reload: async () => {
          await browser.reload();
          await ready();
        },
        setViewport: (size) => browser.setViewport(size),
      });
    },
  );
