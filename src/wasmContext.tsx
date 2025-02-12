"use client";

import { createContext, useEffect, useState } from "react";

export type wasm = typeof import("../recipebridge/pkg");

export const WasmContext = createContext<wasm>({} as wasm);

export const WasmContextProvider: React.FC<{
  children?: React.ReactNode;
}> = ({ children }) => {
  const [state, setState] = useState<wasm>();
  useEffect(() => {
    const fetchWasm = async () => {
      console.time("wasm-load");
      const wasm = await import("recipebridge/pkg/recipebridge");
      setState(wasm);
      console.timeEnd("wasm-load");
    };
    void fetchWasm();
  }, []);

  return (
    state && (
      <WasmContext.Provider value={state}>{children}</WasmContext.Provider>
    )
  );
};
