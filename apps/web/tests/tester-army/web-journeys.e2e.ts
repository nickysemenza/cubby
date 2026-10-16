import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { selectedJourneys } from "../../tooling/tester-army/journey";
import {
  runJourney,
  runJourneyControl,
} from "../../tooling/tester-army/journey-run";
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
      let pickerCapture = 0;
      await runJourney(journey, "web", {
        agent,
        expectOptionVisible: async (name) => {
          const option = screen.getByRole("option", { name, exact: false });
          await expect(option).toBeVisible();
          // Mounted options can be outside the scroller's viewport. Verify
          // the reveal without a tap or scroll that could repair the defect.
          await expect
            .poll(async () => {
              const [row, list] = await Promise.all([
                option.boundingBox(),
                screen.getByRole("listbox").boundingBox(),
              ]);
              return (
                !!row &&
                !!list &&
                row.y >= list.y - 1 &&
                row.y + row.height <= list.y + list.height + 1
              );
            })
            .toBe(true);
          await app.screenshot(`picker-selection-${++pickerCapture}`);
        },
        tapControl: (control) => runJourneyControl(screen, control),
        expectButtonDisabled: (name) =>
          expect(
            screen.getByRole("button", { name, exact: true }),
          ).toBeDisabled(),
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
      if (
        process.env.GITHUB_ACTIONS === "true" &&
        process.env.TESTER_ARMY_CI_EVIDENCE === "1"
      )
        await app.screenshot("verified-outcome");
    },
  );
