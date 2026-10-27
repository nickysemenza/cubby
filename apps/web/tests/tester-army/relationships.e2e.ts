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
      screen.getByText(`Synthetic Replacement Project ${viewport.width}`),
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
    'Move "Synthetic inbox card" from No project to "Synthetic Destination Project". You may use the card\'s Move picker.',
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
  await agent.act(
    'Open Edit Expense and Source claims. Set the source claim Description to "Synthetic claim evidence revised". Leave the editor open with that text.',
  );
  await agent.act(
    "Save changes. Finish on the expense detail page showing the heading Synthetic claim expense.",
  );
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
