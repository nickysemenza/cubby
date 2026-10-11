import { test } from "@e2e-dev/mobile";
import { expect, type Screen, type Locator } from "e2e";

import { selectedJourneys } from "../../tooling/tester-army/journey";
import { runJourney } from "../../tooling/tester-army/journey-run";
import { journeys } from "../../tooling/tester-army/journeys";

// Native AX trees include offscreen rows. Center a setup control in the measured
// Form viewport before tapping, so navigation bars cannot intercept its center.
async function centerInEditor(screen: Screen, target: Locator) {
  const form = await screen.getByTestId("editor.product").boundingBox();
  if (!form) throw new Error("Editor viewport is unavailable");
  const top = form.y + form.height / 4;
  const bottom = form.y + (3 * form.height) / 4;
  for (let step = 0; step < 10; step += 1) {
    const box = await target.boundingBox();
    if (!box) throw new Error("Setup control bounds are unavailable");
    const center = box.y + box.height / 2;
    if (center >= top && center <= bottom) return;
    await screen.swipe({
      direction: center < top ? "up" : "down",
      momentum: "slow",
    });
  }
  throw new Error("Setup control did not reach the editor viewport");
}

for (const journey of selectedJourneys(journeys, "ios"))
  test(journey.title, async ({ app, agent, screen, device }) => {
    await runJourney(journey, "ios", {
      agent,
      tapTestId: (id) => screen.getByTestId(id).tap(),
      expectText: async (text, visible) => {
        const target = screen.getByText(text, { exact: false }).first();
        if (visible) await expect(target).toBeVisible();
        else await expect(target).toBeHidden();
      },
      open: async ({ entity, ios }) => {
        await app.open();
        const link = ios ?? (entity ? `cubby://entity/${entity}` : undefined);
        if (link) await device.openLink(link);
        // This journey tests structured entry; rename separately covers editor navigation.
        // The SDK offers offscreen native buttons to Jev, so establish a reachable start.
        if (journey.id === "field-external-ids") {
          await screen.getByTestId("detail.product.edit").tap();
          const add = screen.getByTestId("editor.product.externalIds.add");
          await screen.scrollUntilVisible(add, { direction: "down" });
          await centerInEditor(screen, add);
          await add.tap();
          await expect(
            screen.getByTestId("editor.product.externalIds.0.source"),
          ).toBeVisible();
        }
      },
      reload: () =>
        Promise.reject(new Error("iOS journeys never wait on a live run")),
    });
    if (
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.TESTER_ARMY_CI_EVIDENCE === "1"
    )
      await app.screenshot("verified-outcome");
  });
