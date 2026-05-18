import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef } from "react";

export function useInvoke() {
  // Stable reference across renders — safe to use in useEffect dep arrays
  // without triggering re-runs.
  const call = useCallback(
    <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      return invoke<T>(command, args);
    },
    [] // invoke is a stable Tauri import; no deps needed
  );

  return { call };
}

export function useTauriEvent<T>(
  event: string,
  handler: (payload: T) => void
) {
  // Keep a ref to the latest handler so the listener never goes stale
  // without needing to re-subscribe. The effect stays keyed on [event] only.
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    listen<T>(event, (e) => handlerRef.current(e.payload)).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [event]); // re-subscribes only if the event name itself changes
}