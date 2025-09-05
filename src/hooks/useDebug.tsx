"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";

interface DebugContextType {
  isDebugEnabled: boolean;
  toggleDebug: () => void;
}

const DebugContext = createContext<DebugContextType | undefined>(undefined);

interface DebugContextProviderProps {
  children: ReactNode;
}

export function DebugContextProvider({ children }: DebugContextProviderProps) {
  const [isDebugEnabled, setIsDebugEnabled] = useState(false);

  // Load debug state from localStorage on mount
  useEffect(() => {
    const savedDebugState = localStorage.getItem("debugTablesEnabled");
    if (savedDebugState) {
      setIsDebugEnabled(JSON.parse(savedDebugState));
    }
  }, []);

  // Save debug state to localStorage when it changes
  useEffect(() => {
    localStorage.setItem("debugTablesEnabled", JSON.stringify(isDebugEnabled));
  }, [isDebugEnabled]);

  const toggleDebug = () => {
    setIsDebugEnabled((prev) => !prev);
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
