import { expect } from "e2e";
import { z } from "zod";
import { test, outcome } from "./journey.fixtures";

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`relationship pickers resolve names and preserve other assignments at ${viewport.width}px`, async ({
    data,
    browser,
    screen,
  }) => {
    await browser.setViewport(viewport);
    const { vendor, replacement, purchase } =
      data.world.pickers[viewport.width === 1280 ? "desktop" : "phone"];
    await data.open(`/purchases/${purchase.id}`);
    await expect(
      screen
        .getByRole("region", "Classification")
        .getByRole("link", `Synthetic Original Project ${viewport.width}`),
    ).toBeVisible();
    await screen.getByRole("button", "Edit Purchase").click();
    const projectPicker = screen
      .getByRole("dialog", "Edit Purchase")
      .getByRole("combobox", "Default project");
    await expect(projectPicker).toHaveValue(
      `Synthetic Original Project ${viewport.width}`,
    );
    await projectPicker.click();
    // Exact-value selection needs no model completion judgment after the option closes.
    await screen
      .getByRole("option", {
        name: new RegExp(`^Synthetic Replacement Project ${viewport.width}\\b`),
      })
      .click();
    await expect(projectPicker).toHaveValue(
      `Synthetic Replacement Project ${viewport.width}`,
    );
    await screen.getByRole("button", "Save changes").click();
    await expect(screen.getByRole("dialog", "Edit Purchase")).toBeHidden();
    outcome(
      await data.fields("purchase", purchase.id, [
        "defaultProjectId",
        "vendorId",
      ]),
      { defaultProjectId: replacement.id, vendorId: vendor.id },
    );
    await data.open(`/purchases/${purchase.id}`);
    await expect(
      screen
        .getByRole("region", "Classification")
        .getByRole("link", `Synthetic Replacement Project ${viewport.width}`),
    ).toBeVisible();
  });
}

test("moving a task between board lanes persists its project without changing siblings", async ({
  data,
  agent,
  screen,
}) => {
  const { project, sibling, task } = data.world.board;
  await data.open(
    `/tasks?view=board&groupBy=${encodeURIComponent(JSON.stringify([{ key: "projectId" }]))}`,
  );
  await screen.getByRole("combobox", "Move Synthetic inbox card").click();
  await expect(
    screen.getByRole("option", "Synthetic Destination Project"),
  ).toBeVisible();
  await agent.act(
    // Board drag-and-drop exposes no addressable drop target to the decision
    // model; the card's own Move picker is the keyboard-accessible path.
    'In the open Move Synthetic inbox card picker, choose "Synthetic Destination Project". Do not drag the card.',
  );
  outcome(await data.fields("task", task.id, ["projectId"]), {
    projectId: project.id,
  });
  outcome(await data.fields("task", sibling.id, ["projectId", "name"]), {
    projectId: project.id,
    name: "Synthetic lane card",
  });
});

test("source claim editing preserves canonical identity and money", async ({
  data,
  agent,
  screen,
}) => {
  const { expense } = data.world.claim;
  const claims = z.object({
    sourceClaims: z.array(
      z.object({
        sourceKey: z.string(),
        source: z.string(),
        normalizedEvidence: z.object({
          amount: z.number(),
          description: z.string(),
        }),
      }),
    ),
  });
  const before = claims.parse(
    await data.fields("expense", expense.id, ["sourceClaims"]),
  );
  const original = before.sourceClaims[0];
  if (!original) throw new Error("Synthetic claim was not created");
  await data.open(`/expenses/${expense.id}`);
  await screen.getByRole("button", "Edit Expense").click();
  // Hydration precedes the async editor defaults; the agent needs the retained claim.
  await expect(
    screen
      .getByRole("dialog", "Edit Expense")
      .getByRole("textbox", "Description"),
  ).toHaveValue("Synthetic claim evidence");
  await agent.act(
    'In the Edit Expense dialog, change the Description of the existing synthetic-provider source claim to "Synthetic claim evidence revised". Keep the existing claim; do not add another row.',
  );
  await screen.getByRole("button", "Save changes").click();
  await expect(screen.getByRole("dialog", "Edit Expense")).toBeHidden();
  const after = claims.parse(
    await data.fields("expense", expense.id, ["sourceClaims"]),
  );
  outcome(
    { count: after.sourceClaims.length, claims: after.sourceClaims },
    {
      count: 1,
      claims: [
        {
          sourceKey: original.sourceKey,
          source: original.source,
          normalizedEvidence: {
            amount: 10,
            description: "Synthetic claim evidence revised",
          },
        },
      ],
    },
  );
  outcome(await data.fields("expense", expense.id, ["cost"]), { cost: 10 });
});
