export interface InventoryDetectionEval {
  name: string;
  locationName: string;
  expectedItems: string[];
  excludedItems: string[];
}

export const INVENTORY_DETECTION_EVALS: InventoryDetectionEval[] = [
  {
    name: "tarps cloths blankets",
    locationName: "tarps cloths blankets",
    expectedItems: ["blue tarp", "painters drop cloth", "plastic drop cloth"],
    excludedItems: [
      "black plastic crate",
      "small blue plastic bag",
      "cream cloth items",
      "various packaged items",
    ],
  },
];
