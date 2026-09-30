import { z } from "zod";
export const macImportSource = z.enum(["csv", "photo", "receipt"]);
export const macImportOrder = z
  .array(macImportSource)
  .length(3)
  .refine(
    (order) => new Set(order).size === 3,
    "Each native evidence source must arrive exactly once",
  );
export type MacImportSource = z.infer<typeof macImportSource>;
export const macImportOrders = [
  ["csv", "photo", "receipt"],
  ["csv", "receipt", "photo"],
  ["photo", "csv", "receipt"],
  ["photo", "receipt", "csv"],
  ["receipt", "csv", "photo"],
  ["receipt", "photo", "csv"],
].map((order) => macImportOrder.parse(order));
