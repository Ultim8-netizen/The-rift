import { useEffect } from "react";
import { useTauriEvent, useInvoke } from "./useTauri";
import { useRiftStore } from "@/store/riftStore";
import { Device, AppState, NetworkStatus } from "@/types";

export function useDeviceEvents() {
  const { call } = useInvoke();

  const addDevice            = useRiftStore((s) => s.addDevice);
  const removeDevice         = useRiftStore((s) => s.removeDevice);
  const updateDeviceLatency  = useRiftStore((s) => s.updateDeviceLatency);
  const setOwnDeviceName     = useRiftStore((s) => s.setOwnDeviceName);
  const setNetworkStatus     = useRiftStore((s) => s.setNetworkStatus);
  const clearDevices         = useRiftStore((s) => s.clearDevices);
  const addRiftedDevice      = useRiftStore((s) => s.addRiftedDevice);
  const removeRiftedDevice   = useRiftStore((s) => s.removeRiftedDevice);
  const addReconnecting      = useRiftStore((s) => s.addReconnectingDevice);
  const removeReconnecting   = useRiftStore((s) => s.removeReconnectingDevice);

  useEffect(() => {
    call<AppState>("get_app_state").then((state) => {
      setOwnDeviceName(state.ownDeviceName);
      setNetworkStatus(state.networkStatus);
    });
    call("start_discovery");
  }, [call, setOwnDeviceName, setNetworkStatus]);

  useTauriEvent<Device>("device_discovered", (device) => {
    addDevice(device);
    setNetworkStatus("connected");
  });

  useTauriEvent<{ id: string }>("device_lost", ({ id }) => {
    removeDevice(id);
  });

  useTauriEvent<{ deviceId: string }>("device_reconnecting", ({ deviceId }) => {
    // Device lost contact but is still in state — just flag it visually.
    addReconnecting(deviceId);
  });

  useTauriEvent<{ deviceId: string }>("device_recovered", ({ deviceId }) => {
    // Heartbeat succeeded again after earlier failures.
    removeReconnecting(deviceId);
  });

  useTauriEvent<{ deviceId: string; latencyMs: number }>(
    "device_latency_update",
    ({ deviceId, latencyMs }) => {
      updateDeviceLatency(deviceId, latencyMs);
      // A successful latency ping means the device is alive — clear reconnecting.
      removeReconnecting(deviceId);
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
    // TCP rift channel is live → device is definitely reachable.
    removeReconnecting(deviceId);
  });

  useTauriEvent<{ deviceId: string }>("device_channel_lost", ({ deviceId }) => {
    removeRiftedDevice(deviceId);
  });
}

export { useDeviceEvents as useDevices };