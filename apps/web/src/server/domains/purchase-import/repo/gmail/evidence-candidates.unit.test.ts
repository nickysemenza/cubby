/** Complete evidence must precede selection: malformed totals, currency, dates,
 * quantities, signs, identity, unknown indexes and changed sources cannot become orders. */
import { describe, expect, it } from "vitest";

import { selectEmailEvidenceCandidate } from "../../service/gmail/candidate-extraction";
import { prepareEmailEvidenceCandidates } from "./evidence-candidates";
const order = () => ({
  "@type": "Order",
  orderNumber: "SYNTHETIC-ORDER",
  orderDate: "2026-10-01",
  seller: { name: "Synthetic shop" },
  priceCurrency: "USD",
  price: "9.00",
  orderedItem: [
    {
      "@type": "OrderItem",
      orderQuantity: 2,
      orderedItem: {
        name: "Synthetic basil",
        offers: { price: "4.00", priceCurrency: "USD" },
      },
    },
  ],
  priceSpecification: [
    { name: "Shipping", price: "2.00", priceCurrency: "USD" },
    { name: "Discount", price: "-1.00", priceCurrency: "USD" },
  ],
});
type SyntheticOrder = ReturnType<typeof order>;
const source = (value: SyntheticOrder | SyntheticOrder[] = order()) => ({
  sourceKey: "gmail:synthetic-mailbox:synthetic-order",
  checksum: "a".repeat(64),
  content: `<p>Synthetic receipt</p><script type="application/ld+json">${JSON.stringify(value)}</script>`,
});
const choose = async () => ({
  selectedIndex: 0,
  confidence: "high" as const,
  probability: 0.95,
});
describe("evidence-bound closed-set Email orders", () => {
  it("abstains on oversized related HTML before parsing or selecting an order", async () => {
    const input = {
      ...source(),
      content: `${source().content}${"x".repeat(200_001)}`,
    };
    const prepared = await prepareEmailEvidenceCandidates(input);
    expect(prepared).toMatchObject({
      candidates: [],
      reason: "source_too_large",
    });
    let calls = 0;
    expect(
      await selectEmailEvidenceCandidate(
        prepared,
        async () => input,
        async () => {
          calls += 1;
          return choose();
        },
      ),
    ).toMatchObject({ status: "abstained", reason: "source_too_large" });
    expect(calls).toBe(0);
  });
  it("parses complete financial facts with a precise immutable evidence span", async () => {
    const input = source();
    const prepared = await prepareEmailEvidenceCandidates(input);
    expect(prepared.candidates).toHaveLength(1);
    const candidate = prepared.candidates[0];
    if (!candidate) throw new Error("Synthetic candidate missing");
    expect(input.content.slice(candidate.span.start, candidate.span.end)).toBe(
      JSON.stringify(order()),
    );
    expect(candidate).toMatchObject({
      sourceKey: input.sourceKey,
      checksum: input.checksum,
      extraction: {
        status: "ready",
        candidate: {
          orderId: "SYNTHETIC-ORDER",
          currency: "USD",
          orderedAt: "2026-10-01",
          printedGrandTotal: 9,
          lines: [
            { amount: 8, quantity: 2 },
            { amount: 2, lineKind: "unclassified" },
            { amount: -1, lineKind: "unclassified" },
          ],
        },
      },
    });
    expect(
      await selectEmailEvidenceCandidate(prepared, async () => input, choose),
    ).toMatchObject({ status: "selected", candidateId: candidate.id });
  });
  it.each([
    "missing_total",
    "sum_mismatch",
    "orderless",
    "wrong_currency",
    "wrong_quantity",
    "wrong_sign",
    "wrong_date",
    "ambiguous_total",
  ])("abstains on %s without asking a model to invent fields", async (kind) => {
    const value = order();
    if (kind === "missing_total") value.price = "";
    if (kind === "sum_mismatch") value.price = "99.00";
    if (kind === "orderless") value.orderNumber = "";
    if (kind === "wrong_currency") value.priceCurrency = "EUR";
    if (kind === "wrong_quantity") value.orderedItem[0]!.orderQuantity = 0;
    if (kind === "wrong_sign") value.priceSpecification[1]!.price = "1.00";
    if (kind === "wrong_date") value.orderDate = "2026-02-30";
    const input = source(
      kind === "ambiguous_total"
        ? [value, { ...value, price: "10.00" }]
        : value,
    );
    const prepared = await prepareEmailEvidenceCandidates(input);
    expect(prepared.candidates).toEqual([]);
    let calls = 0;
    expect(
      await selectEmailEvidenceCandidate(
        prepared,
        async () => input,
        async () => {
          calls++;
          return choose();
        },
      ),
    ).toMatchObject({ status: "abstained" });
    expect(calls).toBe(0);
  });
  it.each([-1, 1, 1.5])(
    "refuses selected index %s outside the closed candidate roster",
    async (selectedIndex) => {
      const input = source();
      const prepared = await prepareEmailEvidenceCandidates(input);
      await expect(
        selectEmailEvidenceCandidate(
          prepared,
          async () => input,
          async () => ({ ...(await choose()), selectedIndex }),
        ),
      ).rejects.toThrow("candidate index");
    },
  );
  it("supports explicit model abstention", async () => {
    const input = source();
    const prepared = await prepareEmailEvidenceCandidates(input);
    expect(
      await selectEmailEvidenceCandidate(
        prepared,
        async () => input,
        async () => ({ ...(await choose()), selectedIndex: null }),
      ),
    ).toMatchObject({ status: "abstained", reason: "model_abstained" });
  });
  it("refuses source changes during selection even when the Email checksum was not advanced", async () => {
    const input = source();
    const prepared = await prepareEmailEvidenceCandidates(input);
    let current = input;
    await expect(
      selectEmailEvidenceCandidate(
        prepared,
        async () => current,
        async () => {
          current = {
            ...input,
            content: input.content.replace("9.00", "90.00"),
          };
          return choose();
        },
      ),
    ).rejects.toThrow("source changed");
  });
});
