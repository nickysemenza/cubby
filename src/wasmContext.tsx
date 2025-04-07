"use client";

import { createContext, useContext, useEffect, useState } from "react";

export type wasm = typeof import("../recipebridge/pkg");

export type wasmState = {
  w: wasm | undefined;
  loading: boolean;
};
export const WasmContext = createContext<wasmState>({
  w: undefined,
  loading: false,
});

export const WasmContextProvider: React.FC<{
  children?: React.ReactNode;
}> = ({ children }) => {
  const [state, setState] = useState<wasm>();
  // const [loading, setLoading] = useState(true);
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
      <WasmContext.Provider value={{ w: state, loading: true }}>
        {children}
      </WasmContext.Provider>
    )
  );
};

export const useWasm = () => {
  return useContext(WasmContext);
};
