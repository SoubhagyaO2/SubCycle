import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export interface Flash {
  kind: 'success' | 'info';
  text: string;
  /** The page the message belongs on. Defaults to the page it was raised on; set it when the action also navigates. */
  path?: string;
}

interface FlashContextValue {
  flash: Flash | null;
  showFlash: (flash: Flash) => void;
  clearFlash: () => void;
}

const FlashContext = createContext<FlashContextValue | null>(null);

/** One-shot confirmation messages. Only ever set after a real API answer confirmed the action. */
export function FlashProvider({ children }: { children: ReactNode }) {
  const [flash, setFlash] = useState<Flash | null>(null);
  const showFlash = useCallback((f: Flash) => setFlash(f), []);
  const clearFlash = useCallback(() => setFlash(null), []);
  const value = useMemo(() => ({ flash, showFlash, clearFlash }), [flash, showFlash, clearFlash]);
  return <FlashContext.Provider value={value}>{children}</FlashContext.Provider>;
}

export function useFlash(): FlashContextValue {
  const ctx = useContext(FlashContext);
  if (!ctx) throw new Error('useFlash must be used inside <FlashProvider>');
  return ctx;
}
