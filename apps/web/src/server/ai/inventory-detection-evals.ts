import type { DetectedInventoryAiResult } from "@cubby/schemas/ai";
import { getMiscDisplayName, isMiscProduct } from "@cubby/shared";

export interface InventoryDetectionEval {
  name: string;
  locationName: string;
  expectedItems: string[];
  excludedItems: string[];
}

export interface InventoryDetectionEvalResult {
  passed: boolean;
  missingExpectedItems: string[];
  presentExcludedItems: string[];
  recognizableMiscItems: string[];
  missingEvidenceItems: string[];
}

const normalizeEvalName = (value: string): string =>
  getMiscDisplayName(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const includesName = (actualNames: string[], expectedName: string): boolean => {
  const expected = normalizeEvalName(expectedName);
  return actualNames.some((actual) => {
    const normalized = normalizeEvalName(actual);
    return normalized === expected || normalized.includes(expected);
  });
};

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

export function evaluateInventoryDetection(
  fixture: InventoryDetectionEval,
  result: DetectedInventoryAiResult,
): InventoryDetectionEvalResult {
  const actualNames = result.items.map((item) => item.name);
  const missingExpectedItems = fixture.expectedItems.filter(
    (name) => !includesName(actualNames, name),
  );
  const presentExcludedItems = fixture.excludedItems.filter((name) =>
    includesName(actualNames, name),
  );
  const recognizableExpected = new Set(
    fixture.expectedItems.map(normalizeEvalName),
  );
  const recognizableMiscItems = result.items
    .filter(
      (item) =>
        (item.isMisc || isMiscProduct(item.name)) &&
        recognizableExpected.has(normalizeEvalName(item.name)),
    )
    .map((item) => item.name);
  const missingEvidenceItems = result.items
    .filter((item) => item.evidence.trim().length === 0)
    .map((item) => item.name);

  return {
    passed:
      missingExpectedItems.length === 0 &&
      presentExcludedItems.length === 0 &&
      recognizableMiscItems.length === 0 &&
      missingEvidenceItems.length === 0,
    missingExpectedItems,
    presentExcludedItems,
    recognizableMiscItems,
    missingEvidenceItems,
  };
}
