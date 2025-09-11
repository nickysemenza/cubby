import { z } from "zod";

export const upc = z.string().min(12).max(14).describe("12 digit UPC code");
export const id = z.uuid().describe("entity identifier");
