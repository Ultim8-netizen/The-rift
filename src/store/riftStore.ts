import { create } from "zustand";
import {
  Device,
  Transfer,
  IncomingRequest,
  IncomingTextPayload,
  NetworkStatus,
  StagedFile,
  ThemeId,
} from "@/types";

interface RiftStore {
  ownDeviceName: string;
  networkStatus: NetworkStatus;
  setOwnDeviceName: (name: string) => void;
  setNetworkStatus: (status: NetworkStatus) => void;

  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
  themePickerOpen: boolean;
  setThemePickerOpen: (open: boolean) => void;

  devices: Device[];
  selectedDevice: Device | null;
  addDevice: (device: Device) => void;
  removeDevice: (deviceId: string) => void;
  clearDevices: () => void;
  updateDeviceLatency: (deviceId: string, latencyMs: number) => void;
  selectDevice: (device: Device | null) => void;

  riftedDevices: string[];
  addRiftedDevice: (id: string) => void;
  removeRiftedDevice: (id: string) => void;

  devicePopup: Device | null;
  setDevicePopup: (device: Device | null) => void;

  transfers: Transfer[];
  addTransfer: (transfer: Transfer) => void;
  updateTransfer: (id: string, updates: Partial<Transfer>) => void;
  removeTransfer: (id: string) => void;

  incomingRequest: IncomingRequest | null;
  setIncomingRequest: (req: IncomingRequest | null) => void;

  incomingText: IncomingTextPayload | null;
  setIncomingText: (payload: IncomingTextPayload | null) => void;

  stagedFiles: StagedFile[];
  setStagedFiles: (files: StagedFile[]) => void;
  clearStagedFiles: () => void;

  isSending: boolean;
  setIsSending: (v: boolean) => void;
}

export const useRiftStore = create<RiftStore>((set) => ({
  ownDeviceName: "This Device",
  networkStatus: "searching",
  setOwnDeviceName: (name) => set({ ownDeviceName: name }),
  setNetworkStatus: (status) => set({ networkStatus: status }),

  theme: "system",
  setTheme: (id) => set({ theme: id }),
  themePickerOpen: false,
  setThemePickerOpen: (open) => set({ themePickerOpen: open }),

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
      selectedDevice: s.selectedDevice?.id === deviceId ? null : s.selectedDevice,
      devicePopup: s.devicePopup?.id === deviceId ? null : s.devicePopup,
    })),
  clearDevices: () =>
    set({ devices: [], selectedDevice: null, riftedDevices: [], devicePopup: null }),
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
    set((s) => ({ riftedDevices: s.riftedDevices.filter((r) => r !== id) })),

  devicePopup: null,
  setDevicePopup: (device) => set({ devicePopup: device }),

  transfers: [],
  addTransfer: (transfer) =>
    set((s) => ({
      transfers: s.transfers.some((t) => t.id === transfer.id)
        ? s.transfers
        : [transfer, ...s.transfers],
    })),
  updateTransfer: (id, updates) =>
    set((s) => ({
      transfers: s.transfers.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),
  removeTransfer: (id) =>
    set((s) => ({ transfers: s.transfers.filter((t) => t.id !== id) })),

  incomingRequest: null,
  setIncomingRequest: (req) => set({ incomingRequest: req }),

  incomingText: null,
  setIncomingText: (payload) => set({ incomingText: payload }),

  stagedFiles: [],
  setStagedFiles: (files) => set({ stagedFiles: files }),
  clearStagedFiles: () => set({ stagedFiles: [] }),

  isSending: false,
  setIsSending: (v) => set({ isSending: v }),
}));