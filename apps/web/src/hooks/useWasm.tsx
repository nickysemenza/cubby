"use client";

import { useEffect, useState } from "react";
import { ensureWasm } from "~/lib/wasm";

/**
 * WasmContextProvider loads WASM and initializes the module singleton.
 * Children are blocked until WASM is ready.
 *
 * After this provider renders, use `wasm` from `~/lib/wasm` for direct WASM calls.
 */
export const WasmContextProvider: React.FC<{
  children?: React.ReactNode;
}> = ({ children }) => {
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const loadWasm = async () => {
      if (ready || loading) return;
      setLoading(true);
      console.time("wasm-load");
      await ensureWasm();
      console.timeEnd("wasm-load");
      setReady(true);
      setLoading(false);
    };
    void loadWasm();
  }, [loading, ready]);

  return (
    <>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white">
          <div className="border-foreground h-8 w-8 animate-spin rounded-full border-t-2 border-b-2"></div>
        </div>
      )}
      {ready && children}
    </>
  );
};
