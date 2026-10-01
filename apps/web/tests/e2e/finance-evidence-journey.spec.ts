import { z } from "zod";
import { expect, test } from "./e2e-test";

// The real writer must distinguish optional paperwork from missing spending,
// and reimbursement credits from vendor receipt totals.
test("books categorized spending and reimbursements without inventing receipts", async ({
  page,
  baseURL,
}) => {
  const create = async (path: string, data: unknown) => {
    const response = await page.request.post(`/api/v1/${path}`, {
      headers: { Origin: baseURL! },
      data: z.json().parse(data),
    });
    expect(response.status(), await response.text()).toBe(201);
    return z
      .object({ item: z.object({ id: z.string() }) })
      .parse(await response.json()).item.id;
  };
  const categoryId = await create("spending-categories", {
    name: "Synthetic dining",
    evidenceExpectation: "not_expected",
    productExpectation: "not_expected",
  });
  const vendorId = await create("vendors", {
    name: "Synthetic Bistro",
    evidenceExpectation: "not_expected",
  });
  const accountId = await create("financial-accounts", {
    name: "Synthetic fixture card",
    identity: { kind: "credit_card", issuer: null, network: "visa" },
  });
  const transactionId = await create("financial-transactions", {
    accountId,
    amount: 120,
    merchant: "Synthetic Bistro",
    kind: "purchase",
    status: "posted",
    postedDate: "2026-09-10",
  });
  const preview = await page.request.post(
    "/api/v1/financialTransaction/previewBooking",
    {
      headers: { Origin: baseURL! },
      data: { transactionId, vendorId, spendingCategoryId: categoryId },
    },
  );
  expect(preview.ok(), await preview.text()).toBeTruthy();
  const decision = await preview.json();
  const commit = await page.request.post(
    "/api/v1/financialTransaction/commitBooking",
    { headers: { Origin: baseURL! }, data: decision },
  );
  expect(commit.ok(), await commit.text()).toBeTruthy();
  const result = z
    .object({ purchaseId: z.string(), expenseId: z.string() })
    .parse(await commit.json());
  const replay = await page.request.post(
    "/api/v1/financialTransaction/commitBooking",
    { headers: { Origin: baseURL! }, data: decision },
  );
  expect(replay.ok(), await replay.text()).toBeTruthy();
  const creditId = await create("financial-transactions", {
    accountId,
    amount: -40,
    merchant: "Synthetic meal reimbursement",
    kind: "income",
    status: "posted",
    postedDate: "2026-09-12",
  });
  const creditPreview = await page.request.post(
    "/api/v1/financialTransaction/previewBooking",
    {
      headers: { Origin: baseURL! },
      data: {
        transactionId: creditId,
        purchaseId: result.purchaseId,
        spendingCategoryId: categoryId,
        economicRole: "reimbursement",
      },
    },
  );
  expect(creditPreview.ok(), await creditPreview.text()).toBeTruthy();
  const credit = await page.request.post(
    "/api/v1/financialTransaction/commitBooking",
    { headers: { Origin: baseURL! }, data: await creditPreview.json() },
  );
  expect(credit.ok(), await credit.text()).toBeTruthy();
  const purchase = await page.request.get(
    `/api/v1/purchases/${result.purchaseId}`,
  );
  expect(purchase.ok(), await purchase.text()).toBeTruthy();
  const saved = z
    .object({
      expenseTotal: z.number(),
      statedTotal: z.null(),
      dataQuality: z.object({ gaps: z.array(z.object({ check: z.string() })) }),
    })
    .parse(await purchase.json());
  expect(saved.expenseTotal).toBe(80);
  expect(saved.dataQuality.gaps.map((gap) => gap.check)).not.toContain(
    "primary_document",
  );
  expect(saved.dataQuality.gaps.map((gap) => gap.check)).not.toContain(
    "order_id",
  );
  await page.goto(`/financial-transactions/${transactionId}`);
  await expect(
    page.getByText("Not expected", { exact: true }).first(),
  ).toBeVisible();
});

// These corrections cross Expense, settlement allocation and transfer ownership.
// A failure at any boundary must leave the reviewed economic graph intact.
test("moves an early reimbursement and converts reviewed booking atomically", async ({
  page,
  baseURL,
}) => {
  const headers = { Origin: baseURL! };
  const create = async (path: string, data: unknown) => {
    const response = await page.request.post(`/api/v1/${path}`, {
      headers,
      data: z.json().parse(data),
    });
    expect(response.status(), await response.text()).toBe(201);
    return z
      .object({ item: z.object({ id: z.string() }) })
      .parse(await response.json()).item.id;
  };
  const post = async (operation: string, data: unknown) => {
    const response = await page.request.post(
      `/api/v1/financialTransaction/${operation}`,
      { headers, data: z.json().parse(data) },
    );
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const categoryId = await create("spending-categories", {
    name: "Synthetic optional paperwork",
    evidenceExpectation: "not_expected",
    productExpectation: "not_expected",
  });
  const vendorId = await create("vendors", {
    name: "Synthetic event vendor",
    evidenceExpectation: "not_expected",
  });
  const fromPartyId = await create("ledger-parties", {
    name: "Synthetic payer",
    kind: "member",
  });
  const toPartyId = await create("ledger-parties", {
    name: "Synthetic recipient",
    kind: "guest",
  });
  const accountId = await create("financial-accounts", {
    name: "Synthetic owned account",
    identity: { kind: "credit_card", issuer: null, network: "visa" },
    ledgerPartyId: fromPartyId,
  });
  const book = async (
    amount: number,
    economicRole: "vendor" | "reimbursement",
  ) => {
    const transactionId = await create("financial-transactions", {
      accountId,
      amount,
      merchant: "Synthetic booked source",
      kind: amount < 0 ? "income" : "purchase",
      status: "posted",
      postedDate: "2026-09-10",
    });
    const review = await post("previewBooking", {
      transactionId,
      vendorId,
      spendingCategoryId: categoryId,
      economicRole,
    });
    const result = z
      .object({ purchaseId: z.string(), expenseId: z.string() })
      .parse(await post("commitBooking", review));
    return { transactionId, ...result };
  };
  const earlyCredit = await book(-40, "reimbursement");
  const original = await book(120, "vendor");
  const attachment = await post("previewBookingCorrection", {
    transactionId: earlyCredit.transactionId,
    action: { kind: "attach_reimbursement", purchaseId: original.purchaseId },
  });
  await post("commitBookingCorrection", attachment);
  const net = await page.request.get(
    `/api/v1/purchases/${original.purchaseId}`,
  );
  expect(
    z.object({ expenseTotal: z.number() }).parse(await net.json()).expenseTotal,
  ).toBe(80);
  const move = await book(20, "vendor");
  const transferId = await create("ledger-transfers", {
    fromPartyId,
    toPartyId,
    amount: 20,
    date: "2026-09-10",
    kind: "internal_move",
  });
  const conversion = await post("previewBookingCorrection", {
    transactionId: move.transactionId,
    action: { kind: "convert_to_transfer", transferId },
  });
  await post("commitBookingCorrection", conversion);
  const converted = await page.request.get(
    `/api/v1/financial-transactions/${move.transactionId}`,
  );
  expect(
    z
      .object({
        kind: z.literal("account_transfer"),
        ledgerTransferId: z.string(),
        coverage: z.object({ booking: z.string() }),
      })
      .parse(await converted.json()),
  ).toMatchObject({
    ledgerTransferId: transferId,
    coverage: { booking: "not_applicable" },
  });
  const retired = await page.request.get(`/api/v1/expenses/${move.expenseId}`);
  expect(retired.status()).toBe(404);
  const edited = await book(25, "vendor");
  const editedTransferId = await create("ledger-transfers", {
    fromPartyId,
    toPartyId,
    amount: 25,
    date: "2026-09-10",
    kind: "internal_move",
  });
  const stale = await post("previewBookingCorrection", {
    transactionId: edited.transactionId,
    action: { kind: "convert_to_transfer", transferId: editedTransferId },
  });
  const update = await page.request.patch(
    `/api/v1/expenses/${edited.expenseId}`,
    { headers, data: { notes: "Synthetic reviewed note change" } },
  );
  expect(update.ok(), await update.text()).toBeTruthy();
  const rejected = await page.request.post(
    "/api/v1/financialTransaction/commitBookingCorrection",
    { headers, data: stale },
  );
  expect(rejected.ok()).toBeFalsy();
  const retained = await page.request.get(
    `/api/v1/expenses/${edited.expenseId}`,
  );
  expect(retained.ok(), await retained.text()).toBeTruthy();
});
