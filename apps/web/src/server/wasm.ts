import * as instance from "@cubby/recipebridge/worker";

import { instrumentWasm, type ImmutableWasm } from "~/lib/wasm-runtime";

/** Worker capabilities; both package subpaths share one initialized module. */
export const wasm: ImmutableWasm<typeof instance> = instrumentWasm(instance);
