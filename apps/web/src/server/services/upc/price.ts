import type { UPCitemdbOffer } from "./types";

type OfferComparability = "comparable" | "incomparable" | "unknown";

export type DecideOfferComparability = (input: {
  itemTitle: string;
  offerTitle: string;
}) => Promise<OfferComparability>;

const MAX_COMPARABLE_OFFERS = 20;

/** Median price of positive, finite offers the decision model confirms match the UPC package. */
export async function extractBestPrice(
  offers: readonly UPCitemdbOffer[],
  itemTitle: string,
  decideComparability: DecideOfferComparability,
): Promise<number | null> {
  const validOffers = offers.filter(
    (offer) => Number.isFinite(offer.price) && offer.price > 0,
  );
  if (validOffers.some((offer) => offer.title.length > 400))
    throw new Error("UPC offer title exceeds the comparison evidence bound");
  if (itemTitle.length > 400)
    throw new Error("UPC item title exceeds the comparison evidence bound");
  if (validOffers.length > MAX_COMPARABLE_OFFERS)
    throw new Error("UPC offer count exceeds the comparison evidence bound");
  const judgments = await Promise.all(
    validOffers.map(async (offer) => ({
      price: offer.price,
      relation: await decideComparability({
        itemTitle,
        offerTitle: offer.title,
      }),
    })),
  );
  const prices = judgments
    .filter(({ relation }) => relation === "comparable")
    .map(({ price }) => price)
    .sort((a, b) => a - b);
  if (prices.length === 0) return null;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 1
    ? prices[mid]!
    : (prices[mid - 1]! + prices[mid]!) / 2;
}
