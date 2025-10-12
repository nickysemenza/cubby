"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useLocalStorage } from "./useLocalStorage";

interface DebugContextType {
  isDebugEnabled: boolean;
  toggleDebug: () => void;
}

const DebugContext = createContext<DebugContextType | undefined>(undefined);

interface DebugContextProviderProps {
  children: ReactNode;
}

export function DebugContextProvider({ children }: DebugContextProviderProps) {
  const [isDebugEnabled, setIsDebugEnabled] = useLocalStorage(
    "debugTablesEnabled",
    false,
  );

  const toggleDebug = () => {
    setIsDebugEnabled((prev: boolean) => !prev);
  };

  return (
    <DebugContext.Provider value={{ isDebugEnabled, toggleDebug }}>
      {children}
    </DebugContext.Provider>
  );
}

export function useDebug() {
  const context = useContext(DebugContext);
  if (context === undefined) {
    throw new Error("useDebug must be used within a DebugContextProvider");
  }
  return context;
}
