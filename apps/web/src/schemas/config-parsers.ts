import { type Amount } from "~/codec/codec";

/**
 * Parses shorthand conversion strings like:
 * - "4 lb = $5"
 * - "1 cup = 120g"
 * - "2 sticks = 226g"
 */
export function parseConversionString(input: string): {
  from: Amount;
  to: Amount;
  source?: string;
} {
  const sourceMatch = input.match(/^(.+?)\s*@\s*(.+)$/);
  const conversionPart = sourceMatch ? sourceMatch[1]!.trim() : input.trim();
  const source = sourceMatch ? sourceMatch[2]!.trim() : undefined;

  const match = conversionPart.match(/^(.+?)\s*=\s*(.+)$/);
  if (!match) {
    throw new Error(
      `Invalid conversion format: "${input}". Expected format: "4 lb = $5" or "4 lb = $5 @ store"`,
    );
  }

  const leftPart = match[1]!.trim();
  const rightPart = match[2]!.trim();

  const from = parseAmount(leftPart);
  const to = parseAmount(rightPart);

  return { from, to, source };
}

/**
 * Parses amount strings like:
 * - "4 lb"
 * - "$5"
 * - "120g"
 * - "1 cup"
 */
function parseAmount(input: string): Amount {
  const currencyMatch = input.match(/^\$(\d+(?:\.\d{1,2})?)$/);
  if (currencyMatch) {
    return {
      value: parseFloat(currencyMatch[1]!),
      unit: "dollars",
    };
  }

  const amountMatch = input.match(/^(\d+(?:\.\d+)?)\s*(.+)$/);
  if (!amountMatch) {
    throw new Error(
      `Invalid amount format: "${input}". Expected format: "4 lb" or "$5"`,
    );
  }

  const value = parseFloat(amountMatch[1]!);
  const unit = amountMatch[2]!.trim();

  return { value, unit };
}

/**
 * Parses shorthand product strings like:
 * - "White sugar: $5/4lb @ whole foods"
 * - "Butter: $8/4sticks"
 */
export function parseProductShorthand(input: string): {
  name: string;
  conversions: string[];
} {
  const colonIndex = input.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(
      `Invalid product shorthand: "${input}". Expected format: "Product Name: $5/4lb @ store"`,
    );
  }

  const name = input.substring(0, colonIndex).trim();
  const conversionPart = input.substring(colonIndex + 1).trim();

  const conversion = convertPriceShorthand(conversionPart);

  return {
    name,
    conversions: [conversion],
  };
}

/**
 * Converts price shorthand like "$5/4lb @ store" to "4 lb = $5 @ store"
 */
function convertPriceShorthand(input: string): string {
  const sourceMatch = input.match(/^(.+?)\s*@\s*(.+)$/);
  const pricePart = sourceMatch ? sourceMatch[1]!.trim() : input.trim();
  const source = sourceMatch ? ` @ ${sourceMatch[2]!.trim()}` : "";

  const match = pricePart.match(/^\$(\d+(?:\.\d{1,2})?)\s*\/\s*(.+)$/);
  if (!match) {
    throw new Error(
      `Invalid price shorthand: "${input}". Expected format: "$5/4lb" or "$5/4lb @ store"`,
    );
  }

  const price = match[1]!;
  const amount = match[2]!.trim();

  const formattedAmount = amount.replace(
    /^(\d+(?:\.\d+)?)([a-zA-Z]+)$/,
    "$1 $2",
  );

  return `${formattedAmount} = $${price}${source}`;
}
