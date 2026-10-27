type PricingCategorySummary = {
  count: number;
  itemNames: string[];
};

export type PricingStatus = {
  priced: PricingCategorySummary;
  missingPricing: PricingCategorySummary;
  miscNoPrice: PricingCategorySummary;
};
