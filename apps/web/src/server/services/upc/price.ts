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
  if (
    itemTitle.length > 400 ||
    validOffers.length > MAX_COMPARABLE_OFFERS ||
    validOffers.some((offer) => offer.title.length > 400)
  ) {
    return null;
  }
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
