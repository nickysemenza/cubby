import { z } from "zod";

export const upc = z.string().min(12).max(14).describe("12 digit UPC code");
export const ndb = z.number().max(99999).min(1000).describe("NDB number");
export const id = z.string().uuid().describe("entity identifier");
