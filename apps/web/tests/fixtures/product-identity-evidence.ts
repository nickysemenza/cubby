/** Fictional evidence for a wardrobe Product reached through photos and purchases. */
export const forgeWearEvidence = {
  labelReading: { fit: "L", size: "S" },
  observedName: "ForgeWear loose fit heavyweight pocket T-shirt black small",
  brand: "ForgeWear",
  products: [
    {
      shortcode: "PRD-4K7M",
      name: "ForgeWear loose fit heavyweight pocket T-shirt black small",
      hasOwnPhoto: true,
      hasPhotoImport: true,
      hasPurchase: true,
      hasInventory: true,
    },
    {
      shortcode: "PRD-8B2Q",
      name: "ForgeWear loose fit heavyweight pocket T-shirt navy small",
      hasOwnPhoto: false,
      hasPhotoImport: false,
      hasPurchase: true,
      hasInventory: false,
    },
    {
      shortcode: "PRD-9C3R",
      name: "ForgeWear loose fit heavyweight pocket T-shirt white small",
      hasOwnPhoto: false,
      hasPhotoImport: false,
      hasPurchase: true,
      hasInventory: false,
    },
    {
      shortcode: "PRD-2D5T",
      name: "ForgeWear loose fit heavyweight pocket T-shirt black medium",
      hasOwnPhoto: false,
      hasPhotoImport: false,
      hasPurchase: true,
      hasInventory: false,
    },
  ],
  retailer: {
    savedPageOrderIds: [
      "111-2222222-3333333",
      "111-2222222-3333333",
      "444-5555555-6666666",
    ],
    trial: {
      orderId: "111-2222222-3333333",
      pageLines: ["ForgeWear black small tee", "Canvas tote", "Cotton socks"],
      finalMail: {
        subject: "Thanks for completing your trial purchase",
        retained: ["Canvas tote", "Cotton socks"],
        toReturn: ["ForgeWear black small tee"],
        chargedAmount: 24.5,
      },
    },
    ordinary: {
      orderId: "444-5555555-6666666",
      pageLines: ["ForgeWear black small tee", "ForgeWear white small tee"],
      mailSubject: "Your heavyweight shirt and one more item have shipped",
      combinedCharge: 39.98,
    },
  },
  statement: [
    { source: "Bank A", date: "2025-04-04", amount: 39.98, rowId: "txn-1" },
    {
      source: "Bank A export copy",
      date: "2025-04-04",
      amount: 39.98,
      rowId: "txn-1",
    },
    { source: "Bank A", date: "2025-04-05", amount: 39.98, rowId: "txn-2" },
  ],
  expected: {
    matchedProduct: "PRD-4K7M",
    uniqueOrders: 2,
    trialShirtPurchased: false,
    ordinaryOrderNeedsSettlementReview: true,
  },
} as const;
