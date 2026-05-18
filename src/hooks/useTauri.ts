import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useEffect } from "react";

export function useInvoke() {
  async function call<T>(
    command: string,
    args?: Record<string, unknown>
  ): Promise<T> {
    return invoke<T>(command, args);
  }
  return { call };
}

export function useTauriEvent<T>(
  event: string,
  handler: (payload: T) => void
) {
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    listen<T>(event, (e) => handler(e.payload)).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [event]);
}