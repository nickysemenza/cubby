import { expect } from "e2e";
import { z } from "zod";
import { test, outcome } from "./journey.fixtures";

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`relationship pickers resolve names and preserve other assignments at ${viewport.width}px`, async ({
    data,
    agent,
    browser,
    screen,
  }) => {
    await browser.setViewport(viewport);
    const { vendor, replacement, purchase } =
      data.world.pickers[viewport.width === 1280 ? "desktop" : "phone"];
    await data.open(`/purchases/${purchase.id}`);
    await expect(
      screen.getByText(`Synthetic Original Project ${viewport.width}`),
    ).toBeVisible();
    await screen.getByRole("button", "Edit Purchase").click();
    await agent.act(
      `In the Edit Purchase dialog, set its Default project to "Synthetic Replacement Project ${viewport.width}".`,
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
        .getByText(`Synthetic Replacement Project ${viewport.width}`)
        .first(),
    ).toBeVisible();
  });
}

test("moving a task between board lanes persists its project without changing siblings", async ({
  data,
  agent,
}) => {
  const { project, sibling, task } = data.world.board;
  await data.open(
    `/tasks?view=board&groupBy=${encodeURIComponent(JSON.stringify([{ key: "projectId" }]))}`,
  );
  await agent.act(
    // Board drag-and-drop exposes no addressable drop target to the decision
    // model; the card's own Move picker is the keyboard-accessible path.
    'Move "Synthetic inbox card" from No project to "Synthetic Destination Project" by opening that card\'s "Move Synthetic inbox card" picker and choosing "Synthetic Destination Project". Do not drag the card.',
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
