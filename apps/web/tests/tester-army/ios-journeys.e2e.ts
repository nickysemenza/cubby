import { test } from "@e2e-dev/mobile";
import { expect, type Screen, type Locator } from "e2e";

import { selectedJourneys } from "../../tooling/tester-army/journey";
import {
  runJourney,
  runJourneyControl,
} from "../../tooling/tester-army/journey-run";
import { journeys } from "../../tooling/tester-army/journeys";

// Native AX trees include offscreen rows. Center a setup control in the measured
// Form viewport before tapping, so navigation bars cannot intercept its center.
async function centerInEditor(screen: Screen, target: Locator, editor: string) {
  const form = await screen.getByTestId(editor).boundingBox();
  if (!form) throw new Error("Editor viewport is unavailable");
  const top = form.y + form.height / 4;
  const bottom = form.y + (form.height * 3) / 4;
  for (let step = 0; step < 10; step += 1) {
    const box = await target.boundingBox();
    if (!box) throw new Error("Setup control bounds are unavailable");
    const center = box.y + box.height / 2;
    if (center >= top && center <= bottom) return;
    const middle = form.y + form.height / 2;
    const distance = Math.max(
      -form.height / 4,
      Math.min(form.height / 4, middle - center),
    );
    const x = form.x + form.width / 8;
    await screen.swipe({
      from: { x, y: middle },
      to: { x, y: middle + distance },
      duration: 500,
    });
  }
  throw new Error("Setup control did not reach the editor viewport");
}

async function revealInContainer(
  screen: Screen,
  target: Locator,
  container: string,
) {
  await screen.getByTestId(container).scrollUntilVisible(target, {
    direction: "down",
    momentum: "slow",
  });
  await centerInEditor(screen, target, container);
}

async function clearKeyboardAccessory(
  screen: Screen,
  field: Locator,
  editor: string,
) {
  // The floating keyboard Done button can cover the focused row.
  const done = screen.getByRole("button", {
    name: "Done",
    exact: true,
  });
  const box = await field.boundingBox();
  const accessory = await done.boundingBox();
  const form = await screen.getByTestId(editor).boundingBox();
  if (!box || !accessory || !form)
    throw new Error("Focused input bounds are unavailable");
  if (box.y + box.height >= accessory.y) {
    // AX field bounds can lag keyboard movement. Start above Done in the label gutter;
    // a gesture inside TextField selects text instead of scrolling the Form.
    const x = form.x + form.width / 8;
    const y = accessory.y - box.height;
    const end = Math.max(
      form.y + box.height,
      y - (box.y + box.height - accessory.y + box.height),
    );
    if (end >= y) throw new Error("No clear keyboard scroll path");
    await screen.swipe({
      from: { x, y },
      to: { x, y: end },
      duration: 500,
    });
    await expect(field).toBeFocused();
  }
}

for (const journey of selectedJourneys(journeys, "ios"))
  test(journey.title, async ({ app, agent, screen, device }) => {
    await runJourney(journey, "ios", {
      agent,
      // iOS 26 can echo the identifier onto a wrapper and its button.
      tapTestId: (id) => device.locator(`id=${id} role=button`).tap(),
      tapControl: async (control) => {
        if (
          control.role === "button" &&
          control.within &&
          "testId" in control.within
        ) {
          const container = control.within.testId;
          const target = screen.getByTestId(container).getByRole(control.role, {
            name: control.name,
            exact: control.exact ?? true,
          });
          await revealInContainer(screen, target, container);
        }
        await runJourneyControl(screen, control);
        if (control.role === "button" && control.name === "Done")
          await expect(
            screen.getByRole("button", { name: "Done", exact: true }),
          ).toBeHidden();
      },
      expectButtonDisabled: (name) =>
        expect(
          screen.getByRole("button", { name, exact: true }),
        ).toBeDisabled(),
      expectText: async (text, visible) => {
        const split = screen.getByTestId("split.form");
        const inSplit = await split.isVisible();
        const target = (inSplit ? split : screen)
          .getByText(text, { exact: false })
          .first();
        if (visible) {
          if (inSplit)
            await split.scrollUntilVisible(target, {
              direction: "down",
              momentum: "slow",
            });
          await expect(target).toBeVisible();
        } else await expect(target).toBeHidden();
      },
      open: async ({ entity, ios }) => {
        const confirmation = device.locator(
          'role=alert label="Open in “Cubby”?"',
        );
        // A failed case can leave a pending URL; discard it before opening this case's URL.
        if (await confirmation.isVisible()) await device.alert("dismiss");
        await app.open();
        // Launch returns while session restoration can still be replacing the root view.
        await expect(
          screen.getByText("Library", { exact: true }).first(),
        ).toBeVisible({ timeout: 60_000 });
        const link = ios ?? (entity ? `cubby://entity/${entity}` : undefined);
        const target = entity
          ? screen.getByText(entity, { exact: true }).first()
          : undefined;
        if (link) {
          await device.openLink(link);
          await expect
            .poll(
              async () =>
                (await confirmation.isVisible()) ||
                (target !== undefined && (await target.isVisible())),
              { timeout: 60_000 },
            )
            .toBe(true);
        }
        if (await confirmation.isVisible()) await device.alert("accept");
        if (target) await expect(target).toBeVisible({ timeout: 60_000 });
        // Structured-entry journeys isolate fields; rename covers editor navigation.
        // The SDK offers offscreen native buttons to Jev, so establish a reachable start.
        const setup =
          journey.id === "field-external-ids"
            ? { entity: "product", field: "externalIds" }
            : journey.id === "field-source-refs"
              ? { entity: "financialTransaction", field: "sourceRefs" }
              : undefined;
        if (setup) {
          const editor = `editor.${setup.entity}`;
          await device
            .locator(`id=detail.${setup.entity}.edit role=button`)
            .tap();
          const add = device.locator(
            `id=${editor}.${setup.field}.add role=button`,
          );
          await revealInContainer(screen, add, editor);
          await add.tap();
          await expect(
            screen.getByTestId(`${editor}.${setup.field}.0.source`),
          ).toBeVisible();
        }
        const input =
          journey.id === "field-source-claim"
            ? {
                entity: "expense",
                field: "sourceClaims.0.normalizedEvidence.description",
              }
            : journey.id === "field-label-nutrition"
              ? { entity: "product", field: "labelNutrition.nutrients.kcal" }
              : journey.id === "field-recipe-line"
                ? {
                    entity: "recipe",
                    field: "sections.0.ingredients.0.amounts.0.value",
                  }
                : undefined;
        if (input) {
          await device
            .locator(`id=detail.${input.entity}.edit role=button`)
            .tap();
          const editor = `editor.${input.entity}`;
          const field = screen.getByTestId(`${editor}.${input.field}`);
          await revealInContainer(screen, field, editor);
          if (journey.id !== "field-recipe-line") await field.focus();
          if (journey.id === "field-source-claim")
            await clearKeyboardAccessory(screen, field, editor);
        }
        const report = journey.id.startsWith("finance-split-")
          ? {
              control: "section.splitExpense",
              detail: "detail.expense",
              heading: screen.getByText("Settlement", { exact: true }),
            }
          : journey.id === "finance-attach-products"
            ? {
                control: "section.linkProducts",
                detail: "detail.purchase",
                heading: screen.getByRole("button", {
                  name: "Reconciliation: Reconciliation",
                  exact: true,
                }),
              }
            : undefined;
        if (report) {
          // The lazy report must appear before its actions enter the AX tree.
          const heading = report.heading;
          await revealInContainer(screen, heading, report.detail);
          await expect(
            device.locator(`id=${report.control} role=button`),
          ).toBeAttached();
          const control = device.locator(`id=${report.control} role=button`);
          await revealInContainer(screen, control, report.detail);
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
