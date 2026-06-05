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

  // Single device discovery (mDNS, broadcast, heartbeat recovery).
  useTauriEvent<Device>("device_discovered", (device) => {
    addDevice(device);
    setNetworkStatus("connected");
  });

  // Batch discovery from subnet scan completion.
  // All devices arrive in one event after the scan finishes, causing a single
  // React reconciliation pass instead of N separate ones that were stacking
  // against Portal3D's animation frame and producing Davey drops.
  // React 18 auto-batches the addDevice calls below into one re-render.
  useTauriEvent<Device[]>("devices_discovered_batch", (devices) => {
    for (const device of devices) {
      addDevice(device);
    }
    if (devices.length > 0) {
      setNetworkStatus("connected");
    }
  });

  useTauriEvent<{ id: string }>("device_lost", ({ id }) => {
    removeDevice(id);
  });

  useTauriEvent<{ deviceId: string }>("device_reconnecting", ({ deviceId }) => {
    addReconnecting(deviceId);
  });

  useTauriEvent<{ deviceId: string }>("device_recovered", ({ deviceId }) => {
    removeReconnecting(deviceId);
  });

  useTauriEvent<{ deviceId: string; latencyMs: number }>(
    "device_latency_update",
    ({ deviceId, latencyMs }) => {
      updateDeviceLatency(deviceId, latencyMs);
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
    removeReconnecting(deviceId);
  });

  useTauriEvent<{ deviceId: string }>("device_channel_lost", ({ deviceId }) => {
    removeRiftedDevice(deviceId);
  });
}

export { useDeviceEvents as useDevices };