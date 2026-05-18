import { useEffect } from "react";
import { useTauriEvent, useInvoke } from "./useTauri";
import { useRiftStore } from "@/store/riftStore";
import { Device, AppState, NetworkStatus } from "@/types";


export function useDevices() {
  const { call } = useInvoke();
  const addDevice = useRiftStore((s) => s.addDevice);
  const removeDevice = useRiftStore((s) => s.removeDevice);
  const updateDeviceLatency = useRiftStore((s) => s.updateDeviceLatency);
  const setOwnDeviceName = useRiftStore((s) => s.setOwnDeviceName);
  const setNetworkStatus = useRiftStore((s) => s.setNetworkStatus);

  useEffect(() => {
    call<AppState>("get_app_state").then((state) => {
      setOwnDeviceName(state.ownDeviceName);
      setNetworkStatus(state.networkStatus);
    });

    call("start_discovery");
  }, []);

  useTauriEvent<Device>("device_discovered", (device) => {
    addDevice(device);
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
}