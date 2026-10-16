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
              return browser.evaluate((label) => {
                const option = Array.from(
                  document.querySelectorAll('[role="option"]'),
                ).find((item) =>
                  item.getAttribute("aria-label")?.includes(label),
                );
                const row = option?.getBoundingClientRect();
                const list = option
                  ?.closest('[role="listbox"]')
                  ?.getBoundingClientRect();
                return (
                  !!row &&
                  !!list &&
                  row.y >= list.y - 1 &&
                  row.bottom <= list.bottom + 1
                );
              }, name);
            })
            .toBe(true);
          await app.screenshot(`picker-selection-${++pickerCapture}`);
        },
        tapControl: async (control) => {
          if (control.center) {
            if (control.role !== "button" || control.exact === false)
              throw new Error(
                "Centered setup needs an exactly labelled button",
              );
            await browser.evaluate(async (name) => {
              const target = Array.from(
                document.querySelectorAll("button"),
              ).find((button) => {
                const rect = button.getBoundingClientRect();
                return (
                  button.getAttribute("aria-label") === name &&
                  rect.width > 0 &&
                  rect.height > 0 &&
                  getComputedStyle(button).visibility === "visible" &&
                  !button.closest('[aria-hidden="true"], [inert]')
                );
              });
              if (!target) throw new Error(`No labelled button: ${name}`);
              const field =
                target.closest('[data-slot="basic-info-value"]') ?? target;
              field.scrollIntoView({ block: "center", behavior: "instant" });
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              );
              const rect = target.getBoundingClientRect();
              const hit = document.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              );
              if (!hit || !target.contains(hit))
                throw new Error(
                  `Centered ${name} is obstructed at ${Math.round(rect.x)},${Math.round(rect.y)} by ${hit?.tagName}: ${hit?.className}`,
                );
              return null;
            }, control.name);
          }
          await runJourneyControl(screen, control);
        },
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
