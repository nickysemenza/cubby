import type { z } from "zod";

import type { nativeBridgeSchema } from "../lib/native-workspace/contract";

// A runtime module in a global declaration's import closure makes ordinary
// route/server edits invalidate the whole program.
declare global {
  interface Window {
    webkit?: z.infer<typeof nativeBridgeSchema>["webkit"];
  }
}
