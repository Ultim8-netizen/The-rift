import { useState, useEffect } from "react";

const MOBILE_BREAKPOINT = 768;
const MQ_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

export function useMobile(): boolean {
  // Initialise directly from matchMedia — no sync setState needed in the effect.
  const [isMobile, setIsMobile] = useState<boolean>(
    () => window.matchMedia(MQ_QUERY).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(MQ_QUERY);

    // setState lives only in the callback — the ESLint-approved pattern.
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);

    return () => mq.removeEventListener("change", handler);
  }, []);

  return isMobile;
}