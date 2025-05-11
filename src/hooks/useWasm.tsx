"use client";

import { createContext, useContext, useEffect, useState } from "react";

export type wasm = typeof import("../../recipebridge/pkg/recipebridge");

type wasmState = {
  wasm: wasm | undefined;
  loading: boolean;
};
const WasmContext = createContext<wasmState>({
  wasm: undefined,
  loading: false,
});

export const WasmContextProvider: React.FC<{
  children?: React.ReactNode;
}> = ({ children }) => {
  const [state, setState] = useState<wasm>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const fetchWasm = async () => {
      if (state !== undefined || loading) {
        console.log("wasm-load: skipping");
        return;
      }
      setLoading(true);
      console.time("wasm-load");
      const wasm = await import("recipebridge/pkg/recipebridge");
      setState(wasm);
      console.timeEnd("wasm-load");
      setLoading(false);
    };
    void fetchWasm();
  }, [loading, state]);

  return (
    <WasmContext.Provider value={{ wasm: state, loading }}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white">
          <div className="h-8 w-8 animate-spin rounded-full border-t-2 border-b-2 border-gray-900"></div>
        </div>
      )}
      {state && children}
    </WasmContext.Provider>
  );
};

export const useWasm = (): wasm => {
  const { wasm } = useContext(WasmContext);
  if (!wasm) {
    throw new Error("WasmContext not initialized");
  }
  return wasm;
};
