import { create } from "zustand";
import {
  Device,
  Transfer,
  IncomingRequest,
  NetworkStatus,
  StagedFile,
} from "@/types";

interface RiftStore {
  ownDeviceName: string;
  networkStatus: NetworkStatus;
  setOwnDeviceName: (name: string) => void;
  setNetworkStatus: (status: NetworkStatus) => void;

  devices: Device[];
  selectedDevice: Device | null;
  addDevice: (device: Device) => void;
  removeDevice: (deviceId: string) => void;
  clearDevices: () => void;
  updateDeviceLatency: (deviceId: string, latencyMs: number) => void;
  selectDevice: (device: Device | null) => void;

  /** Device IDs with an active TCP rift channel. */
  riftedDevices: string[];
  addRiftedDevice: (id: string) => void;
  removeRiftedDevice: (id: string) => void;

  /** Device shown in the detail popup (null = popup closed). */
  devicePopup: Device | null;
  setDevicePopup: (device: Device | null) => void;

  transfers: Transfer[];
  addTransfer: (transfer: Transfer) => void;
  updateTransfer: (id: string, updates: Partial<Transfer>) => void;
  removeTransfer: (id: string) => void;

  incomingRequest: IncomingRequest | null;
  setIncomingRequest: (req: IncomingRequest | null) => void;

  stagedFiles: StagedFile[];
  setStagedFiles: (files: StagedFile[]) => void;
  clearStagedFiles: () => void;

  /** Prevents duplicate send invocations. */
  isSending: boolean;
  setIsSending: (v: boolean) => void;
}

export const useRiftStore = create<RiftStore>((set) => ({
  ownDeviceName: "This Device",
  networkStatus: "searching",
  setOwnDeviceName: (name) => set({ ownDeviceName: name }),
  setNetworkStatus: (status) => set({ networkStatus: status }),

  devices: [],
  selectedDevice: null,
  addDevice: (device) =>
    set((s) => ({
      devices: s.devices.some((d) => d.id === device.id)
        ? s.devices.map((d) => (d.id === device.id ? device : d))
        : [...s.devices, device],
    })),
  removeDevice: (deviceId) =>
    set((s) => ({
      devices: s.devices.filter((d) => d.id !== deviceId),
      selectedDevice:
        s.selectedDevice?.id === deviceId ? null : s.selectedDevice,
      devicePopup:
        s.devicePopup?.id === deviceId ? null : s.devicePopup,
    })),
  clearDevices: () =>
    set({
      devices: [],
      selectedDevice: null,
      riftedDevices: [],
      devicePopup: null,
    }),
  updateDeviceLatency: (deviceId, latencyMs) =>
    set((s) => ({
      devices: s.devices.map((d) =>
        d.id === deviceId ? { ...d, latencyMs } : d
      ),
    })),
  selectDevice: (device) => set({ selectedDevice: device }),

  riftedDevices: [],
  addRiftedDevice: (id) =>
    set((s) => ({
      riftedDevices: s.riftedDevices.includes(id)
        ? s.riftedDevices
        : [...s.riftedDevices, id],
    })),
  removeRiftedDevice: (id) =>
    set((s) => ({
      riftedDevices: s.riftedDevices.filter((r) => r !== id),
    })),

  devicePopup: null,
  setDevicePopup: (device) => set({ devicePopup: device }),

  transfers: [],
  addTransfer: (transfer) =>
    set((s) => ({
      // Deduplicate by id — prevents double-add from any stray duplicate event
      transfers: s.transfers.some((t) => t.id === transfer.id)
        ? s.transfers
        : [transfer, ...s.transfers],
    })),
  updateTransfer: (id, updates) =>
    set((s) => ({
      transfers: s.transfers.map((t) =>
        t.id === id ? { ...t, ...updates } : t
      ),
    })),
  removeTransfer: (id) =>
    set((s) => ({ transfers: s.transfers.filter((t) => t.id !== id) })),

  incomingRequest: null,
  setIncomingRequest: (req) => set({ incomingRequest: req }),

  stagedFiles: [],
  setStagedFiles: (files) => set({ stagedFiles: files }),
  clearStagedFiles: () => set({ stagedFiles: [] }),

  isSending: false,
  setIsSending: (v) => set({ isSending: v }),
}));