import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useRiftStore } from "@/store/riftStore";
import { HotspotInfo } from "@/types";

export function useHotspot() {
  const setHotspotInfo   = useRiftStore((s) => s.setHotspotInfo);
  const setHotspotRole   = useRiftStore((s) => s.setHotspotRole);
  const setNetworkStatus = useRiftStore((s) => s.setNetworkStatus);
  const hotspotInfo      = useRiftStore((s) => s.hotspotInfo);
  const hotspotRole      = useRiftStore((s) => s.hotspotRole);

  const startHotspot = useCallback(async (): Promise<HotspotInfo> => {
    const info = await invoke<HotspotInfo>("start_hotspot");
    setHotspotInfo(info);
    setHotspotRole("host");
    setNetworkStatus("hotspot");
    return info;
  }, [setHotspotInfo, setHotspotRole, setNetworkStatus]);

  const stopHotspot = useCallback(async (): Promise<void> => {
    await invoke<void>("stop_hotspot");
    setHotspotInfo(null);
    setHotspotRole("none");
    setNetworkStatus("searching");
  }, [setHotspotInfo, setHotspotRole, setNetworkStatus]);

  const joinHotspot = useCallback(
    async (ssid: string, password: string): Promise<HotspotInfo> => {
      const info = await invoke<HotspotInfo>("connect_to_hotspot", { ssid, password });
      setHotspotInfo(info);
      setHotspotRole("guest");
      setNetworkStatus("hotspot");
      return info;
    },
    [setHotspotInfo, setHotspotRole, setNetworkStatus]
  );

  // Detects an already-running hotspot (user enabled it manually in Windows Settings).
  // Does not attempt to create one. Triggers a rescan after detection.
  const detectHotspot = useCallback(async (): Promise<HotspotInfo> => {
    const info = await invoke<HotspotInfo>("detect_hotspot");
    setHotspotInfo(info);
    setHotspotRole("host");
    setNetworkStatus("hotspot");
    return info;
  }, [setHotspotInfo, setHotspotRole, setNetworkStatus]);

  return { hotspotInfo, hotspotRole, startHotspot, stopHotspot, joinHotspot, detectHotspot };
}