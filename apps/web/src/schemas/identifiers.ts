import { z } from "zod";
export const id = z.uuid().describe("entity identifier");
