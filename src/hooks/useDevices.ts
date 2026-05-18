import { useEffect } from "react";
import { useTauriEvent, useInvoke } from "./useTauri";
import { useRiftStore } from "@/store/riftStore";
import { Device, AppState, NetworkStatus } from "@/types";

export function useDeviceEvents() {
  const { call } = useInvoke();

  const addDevice = useRiftStore((s) => s.addDevice);
  const removeDevice = useRiftStore((s) => s.removeDevice);
  const updateDeviceLatency = useRiftStore((s) => s.updateDeviceLatency);
  const setOwnDeviceName = useRiftStore((s) => s.setOwnDeviceName);
  const setNetworkStatus = useRiftStore((s) => s.setNetworkStatus);
  const clearDevices = useRiftStore((s) => s.clearDevices);
  const addRiftedDevice = useRiftStore((s) => s.addRiftedDevice);
  const removeRiftedDevice = useRiftStore((s) => s.removeRiftedDevice);

  useEffect(() => {
    call<AppState>("get_app_state").then((state) => {
      setOwnDeviceName(state.ownDeviceName);
      setNetworkStatus(state.networkStatus);
    });
    call("start_discovery");
  }, [call, setOwnDeviceName, setNetworkStatus]);
  // call   — stable: useCallback([], []) in useInvoke
  // setOwnDeviceName / setNetworkStatus — stable: Zustand actions never change reference

  useTauriEvent<Device>("device_discovered", (device) => {
    addDevice(device);
    setNetworkStatus("connected");
  });

  useTauriEvent<{ id: string }>("device_lost", ({ id }) => {
    removeDevice(id);
  });

  useTauriEvent<{ deviceId: string; latencyMs: number }>(
    "device_latency_update",
    ({ deviceId, latencyMs }) => {
      updateDeviceLatency(deviceId, latencyMs);
    }
  );

  useTauriEvent<{ status: string }>("network_status_changed", ({ status }) => {
    setNetworkStatus(status as NetworkStatus);
  });

  useTauriEvent<null>("devices_cleared", () => {
    clearDevices();
    setNetworkStatus("searching");
  });

  useTauriEvent<{ deviceId: string }>("device_channel_connected", ({ deviceId }) => {
    addRiftedDevice(deviceId);
  });

  useTauriEvent<{ deviceId: string }>("device_channel_lost", ({ deviceId }) => {
    removeRiftedDevice(deviceId);
  });
}

// Kept for backward-compat import name used by App.tsx
export { useDeviceEvents as useDevices };