export const productReuseFixture = {
  expected: {
    reusedProductId: "PRD-EXISTING1",
    purchaseId: "PUR-IMPORTED1",
    finalStatus: "completed",
  },
  result: {
    toolCalls: [
      {
        name: "mcp__cubby__prepare_purchase_import",
        runOperationId: "prepare:order:vendor-1001",
      },
      { name: "mcp__cubby__search_entities" },
      {
        name: "mcp__cubby__commit_purchase_import",
        runOperationId: "commit:order:vendor-1001",
      },
      {
        name: "mcp__cubby__commit_purchase_import",
        runOperationId: "commit:order:vendor-1001",
      },
    ],
    products: [
      {
        id: "PRD-EXISTING1",
        name: "Reusable placeholder product",
      },
    ],
    purchases: [
      {
        id: "PUR-IMPORTED1",
        productId: "PRD-EXISTING1",
        externalOrderId: "vendor-1001",
      },
    ],
    commitResults: [
      {
        operationId: "commit:order:vendor-1001",
        outcome: "created",
        purchaseId: "PUR-IMPORTED1",
      },
      {
        operationId: "commit:order:vendor-1001",
        outcome: "replayed",
        purchaseId: "PUR-IMPORTED1",
      },
    ],
    finalStatus: "completed",
  },
} as const;
