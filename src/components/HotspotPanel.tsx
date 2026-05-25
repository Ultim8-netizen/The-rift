import { useEffect, useRef, useState } from "react";
import { useRiftStore } from "@/store/riftStore";
import { useHotspot } from "@/hooks/useHotspot";

type Tab = "host" | "join";

function translateError(raw: string): string {
  const r = raw.toLowerCase();
  if (r.includes("no network profile") || r.includes("profile available") || r.includes("profile found")) {
    return "No internet connection found. Connect to the internet first, then try again. Or enable Mobile Hotspot manually in Windows Settings and tap Detect below.";
  }
  if (r.includes("adapter") || r.includes("hostednetwork") || r.includes("mode=allow") || r.includes("not support")) {
    return "Your WiFi adapter does not support this mode. Enable Mobile Hotspot manually in Windows Settings (Network & Internet → Mobile hotspot), then tap Detect below.";
  }
  if (r.includes("administrator") || r.includes("privilege") || r.includes("admin")) {
    return "The Rift needs administrator privileges to create a hotspot. Please restart the app as Administrator.";
  }
  if (r.includes("tetheringstat") || r.includes("status=")) {
    return "Windows could not start the hotspot. Try enabling it manually in Settings → Network & Internet → Mobile hotspot, then tap Detect below.";
  }
  if (r.includes("could not start") || r.includes("automatically")) {
    return raw;
  }
  return "Could not start the hotspot automatically. Enable Mobile Hotspot in Windows Settings, then tap Detect below.";
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[9px] font-mono text-rift-muted/60 uppercase tracking-[0.18em]">
        {label}
      </span>
      <div
        className="flex items-center gap-2 rounded-xl px-3 py-2"
        style={{ background: "rgb(var(--rift-surface2) / 0.6)" }}
      >
        <span className="flex-1 font-mono text-xs text-rift-text tracking-wider truncate">
          {value}
        </span>
        <button
          onClick={copy}
          className={`
            text-[9px] font-mono font-bold tracking-widest uppercase px-2 py-1 rounded-lg
            transition-all duration-150 flex-shrink-0
            ${copied
              ? "text-rift-success border border-rift-success/30 bg-rift-success/10"
              : "text-rift-accent/80 border border-rift-accent/25 hover:bg-rift-accent/8"}
          `}
        >
          {copied ? "✓" : "COPY"}
        </button>
      </div>
    </div>
  );
}

export function HotspotPanel() {
  const open    = useRiftStore((s) => s.hotspotPanelOpen);
  const setOpen = useRiftStore((s) => s.setHotspotPanelOpen);
  const { hotspotInfo, hotspotRole, startHotspot, stopHotspot, joinHotspot, detectHotspot } =
    useHotspot();

  const [tab, setTab]               = useState<Tab>("host");
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [joinSsid, setJoinSsid]     = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [open, setOpen]);

  if (!open) return null;

  async function handleStartHotspot() {
    setLoading(true);
    setError(null);
    try {
      await startHotspot();
    } catch (e: unknown) {
      setError(translateError(String(e)));
    } finally {
      setLoading(false);
    }
  }

  async function handleStopHotspot() {
    setLoading(true);
    setError(null);
    try {
      await stopHotspot();
    } catch (e: unknown) {
      setError(translateError(String(e)));
    } finally {
      setLoading(false);
    }
  }

  async function handleJoin() {
    if (!joinSsid.trim() || !joinPassword.trim()) {
      setError("Network name and password are required.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await joinHotspot(joinSsid.trim(), joinPassword.trim());
    } catch (e: unknown) {
      setError(translateError(String(e)));
    } finally {
      setLoading(false);
    }
  }

  async function handleDetect() {
    setLoading(true);
    setError(null);
    try {
      await detectHotspot();
    } catch {
      // detectHotspot failure always maps to this fixed message; binding unused
      setError("No active hotspot found. Make sure Mobile Hotspot is turned on in Windows Settings, then try again.");
    } finally {
      setLoading(false);
    }
  }

  const isHosting = hotspotRole === "host"  && hotspotInfo !== null;
  const isGuest   = hotspotRole === "guest" && hotspotInfo !== null;

  const wasDetected = isHosting && hotspotInfo?.password === "";

  return (
    <div
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) setOpen(false); }}
      className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in"
      style={{ background: "rgb(0 0 0 / 0.55)", backdropFilter: "blur(14px)" }}
    >
      <div
        className="glass-heavy rounded-3xl w-80 shadow-glass overflow-hidden animate-slide-up"
        style={{ width: "20rem" }}
      >
        {/* Accent bar */}
        <div
          className="h-0.5"
          style={{
            background:
              "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)), transparent)",
          }}
        />

        <div className="p-5">
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-[9px] font-mono text-rift-muted/55 uppercase tracking-[0.2em] mb-1">
                Hotspot
              </p>
              <p className="font-semibold text-rift-text text-sm">
                {isHosting
                  ? wasDetected ? "Hotspot Detected" : "Your Hotspot is Active"
                  : isGuest
                  ? "Connected to Hotspot"
                  : "Connect Without a Router"}
              </p>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="text-rift-muted/50 hover:text-rift-text text-xs font-mono border border-rift-border/40 rounded-lg w-7 h-7 flex items-center justify-center transition-colors"
            >
              ✕
            </button>
          </div>

          {/* Active host state */}
          {isHosting && hotspotInfo && (
            <div className="flex flex-col gap-3">
              {wasDetected ? (
                <p className="text-[10px] font-mono text-rift-muted/70 leading-relaxed">
                  Running on{" "}
                  <span className="text-rift-accent font-semibold">{hotspotInfo.gatewayIp}</span>.
                  The other device should already be connected. The Rift will discover it automatically.
                </p>
              ) : (
                <p className="text-[10px] font-mono text-rift-muted/70 leading-relaxed">
                  On the other device, open Wi-Fi settings and connect using the credentials below, then open The Rift.
                </p>
              )}

              {!wasDetected && (
                <>
                  <CopyField label="Network Name (SSID)" value={hotspotInfo.ssid} />
                  <CopyField label="Password" value={hotspotInfo.password} />
                </>
              )}
              <CopyField label="Gateway (Host IP)" value={hotspotInfo.gatewayIp} />

              <button
                onClick={handleStopHotspot}
                disabled={loading}
                className="mt-1 w-full py-2.5 rounded-xl border border-rift-error/30 text-rift-error/80 text-xs font-mono tracking-widest uppercase hover:bg-rift-error/8 transition-all"
              >
                {loading ? "Stopping…" : "Stop Hotspot"}
              </button>
            </div>
          )}

          {/* Active guest state */}
          {isGuest && hotspotInfo && (
            <div className="flex flex-col gap-3">
              <p className="text-[10px] font-mono text-rift-muted/70 leading-relaxed">
                Connected to{" "}
                <span className="text-rift-accent font-semibold">{hotspotInfo.ssid}</span>.
                The Rift is scanning for the host device.
              </p>
              <CopyField label="Gateway (Host IP)" value={hotspotInfo.gatewayIp} />
              <button
                onClick={() => {
                  useRiftStore.getState().setHotspotInfo(null);
                  useRiftStore.getState().setHotspotRole("none");
                  useRiftStore.getState().setNetworkStatus("searching");
                  setOpen(false);
                }}
                className="mt-1 w-full py-2.5 rounded-xl border border-rift-border/40 text-rift-muted/70 text-xs font-mono tracking-widest uppercase hover:border-rift-accent/30 hover:text-rift-muted transition-all"
              >
                Disconnect
              </button>
            </div>
          )}

          {/* Idle state */}
          {!isHosting && !isGuest && (
            <>
              {/* Tabs */}
              <div
                className="flex rounded-xl p-1 mb-4"
                style={{ background: "rgb(var(--rift-surface2) / 0.5)" }}
              >
                {(["host", "join"] as Tab[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => { setTab(t); setError(null); }}
                    className={`
                      flex-1 py-1.5 rounded-lg text-[10px] font-mono font-bold uppercase tracking-widest
                      transition-all duration-150
                      ${tab === t
                        ? "bg-rift-accent/15 text-rift-accent border border-rift-accent/25"
                        : "text-rift-muted/60 hover:text-rift-muted"}
                    `}
                  >
                    {t === "host" ? "Create" : "Join"}
                  </button>
                ))}
              </div>

              {tab === "host" && (
                <div className="flex flex-col gap-3">
                  <p className="text-[10px] font-mono text-rift-muted/70 leading-relaxed">
                    This device creates a Wi-Fi hotspot. The other device connects to it using the
                    generated credentials. Requires administrator privileges on Windows.
                  </p>
                  <button
                    onClick={handleStartHotspot}
                    disabled={loading}
                    className="w-full py-2.5 rounded-xl text-rift-bg text-xs font-mono font-bold tracking-widest uppercase transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      background: "linear-gradient(135deg, rgb(var(--rift-accent)), rgb(var(--rift-accent-dim)))",
                    }}
                  >
                    {loading ? "Starting…" : "Create Hotspot"}
                  </button>
                </div>
              )}

              {tab === "join" && (
                <div className="flex flex-col gap-3">
                  <p className="text-[10px] font-mono text-rift-muted/70 leading-relaxed">
                    Enter the SSID and password shown on the host device.
                    The Rift will connect automatically.
                  </p>
                  <div className="flex flex-col gap-2">
                    <input
                      type="text"
                      placeholder="Network name (SSID)"
                      value={joinSsid}
                      onChange={(e) => setJoinSsid(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl text-xs font-mono text-rift-text placeholder-rift-muted/40 border border-rift-border/50 bg-transparent focus:outline-none focus:border-rift-accent/50 transition-colors"
                    />
                    <input
                      type="password"
                      placeholder="Password"
                      value={joinPassword}
                      onChange={(e) => setJoinPassword(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void handleJoin(); }}
                      className="w-full px-3 py-2 rounded-xl text-xs font-mono text-rift-text placeholder-rift-muted/40 border border-rift-border/50 bg-transparent focus:outline-none focus:border-rift-accent/50 transition-colors"
                    />
                  </div>
                  <button
                    onClick={handleJoin}
                    disabled={loading || !joinSsid.trim() || !joinPassword.trim()}
                    className="w-full py-2.5 rounded-xl text-rift-bg text-xs font-mono font-bold tracking-widest uppercase transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      background: "linear-gradient(135deg, rgb(var(--rift-accent)), rgb(var(--rift-accent-dim)))",
                    }}
                  >
                    {loading ? "Connecting…" : "Join Hotspot"}
                  </button>
                </div>
              )}
            </>
          )}

          {/* Error display */}
          {error && (
            <div className="mt-3 flex flex-col gap-2">
              <div
                className="rounded-xl px-3 py-2.5"
                style={{ background: "rgb(var(--rift-error) / 0.08)" }}
              >
                <p className="text-[10px] font-mono text-rift-error/90 leading-snug">
                  {error}
                </p>
              </div>

              {tab === "host" && (
                <button
                  onClick={handleDetect}
                  disabled={loading}
                  className="w-full py-2.5 rounded-xl border border-rift-accent/30 text-rift-accent text-xs font-mono font-bold tracking-widest uppercase hover:bg-rift-accent/8 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? "Detecting…" : "Detect Active Hotspot"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}