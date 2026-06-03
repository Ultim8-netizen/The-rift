import { useRiftStore } from "@/store/riftStore";
import { setAndPersistTheme } from "@/hooks/useTheme";
import type { ThemeId } from "@/types";

const THEME_OPTIONS: { id: ThemeId; label: string; bg: string; accent: string }[] = [
  { id: "dark-black",  label: "Void",   bg: "#08080e", accent: "#00c8ff" },
  { id: "dark-blue",   label: "Abyss",  bg: "#04081e", accent: "#60b6ff" },
  { id: "dark-grey",   label: "Slate",  bg: "#0b0b0e", accent: "#bcc2d2" },
  { id: "dark-purple", label: "Cosmos", bg: "#080416", accent: "#c06cff" },
  { id: "light-pink",  label: "Rose",   bg: "#fff2fa", accent: "#d03e8a" },
  { id: "light-lemon", label: "Citrus", bg: "#ffffe6", accent: "#918700" },
  { id: "light-blue",  label: "Sky",    bg: "#e6f2ff", accent: "#1270d6" },
];

export function MobileThemePicker({ onClose }: { onClose: () => void }) {
  const currentTheme = useRiftStore((s) => s.theme);
  const setTheme     = useRiftStore((s) => s.setTheme);

  function select(id: ThemeId) {
    setAndPersistTheme(id);
    setTheme(id);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center animate-fade-in"
      style={{ background: "rgb(0 0 0 / 0.65)", backdropFilter: "blur(18px)" }}
      onClick={onClose}
    >
      <div
        className="glass-heavy w-full animate-slide-up overflow-hidden"
        style={{
          borderRadius: "32px 32px 0 0",
          maxWidth: 480,
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{
          height: 3,
          background: "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)), transparent)",
          boxShadow: "0 0 28px rgb(var(--rift-glow) / 0.55)",
        }} />

        <div className="px-6 pt-5 pb-8">
          <div className="flex items-center justify-between mb-5">
            <p
              className="text-[9px] font-mono uppercase tracking-[0.3em]"
              style={{ color: "rgb(var(--rift-muted) / 0.45)" }}
            >
              Appearance
            </p>
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-full text-[11px] font-mono"
              style={{ background: "rgb(var(--rift-surface2) / 0.65)", color: "rgb(var(--rift-muted) / 0.55)" }}
            >
              ✕
            </button>
          </div>

          <button
            onClick={() => select("system")}
            className="w-full flex items-center justify-between px-4 py-3 rounded-2xl mb-5 text-xs font-mono transition-all"
            style={{
              background: currentTheme === "system"
                ? "rgb(var(--rift-accent) / 0.1)"
                : "rgb(var(--rift-surface2) / 0.38)",
              color: currentTheme === "system"
                ? "rgb(var(--rift-accent))"
                : "rgb(var(--rift-muted) / 0.6)",
              boxShadow: currentTheme === "system"
                ? "0 0 0 1px rgb(var(--rift-accent) / 0.3), 0 0 18px rgb(var(--rift-glow) / 0.12)"
                : "0 0 0 1px rgb(255 255 255 / 0.04)",
            }}
          >
            <span className="uppercase tracking-widest text-[10px]">Auto / System</span>
            {currentTheme === "system" && (
              <span style={{ color: "rgb(var(--rift-accent))" }}>✓</span>
            )}
          </button>

          <div className="flex gap-3 flex-wrap">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                onClick={() => select(opt.id)}
                className="flex flex-col items-center gap-1.5"
              >
                <div
                  className="w-12 h-12 rounded-2xl relative transition-all duration-150 active:scale-90"
                  style={{
                    background: opt.bg,
                    boxShadow: currentTheme === opt.id
                      ? `0 0 0 2.5px ${opt.accent}, 0 0 22px ${opt.accent}55`
                      : `0 0 0 1px ${opt.accent}28`,
                  }}
                >
                  <span
                    className="absolute bottom-1.5 right-1.5 w-2.5 h-2.5 rounded-full"
                    style={{ background: opt.accent, boxShadow: `0 0 7px ${opt.accent}99` }}
                  />
                  {currentTheme === opt.id && (
                    <span
                      className="absolute top-1 left-1.5 text-[9px] font-mono font-bold"
                      style={{ color: opt.accent }}
                    >
                      ✓
                    </span>
                  )}
                </div>
                <span
                  className="text-[9px] font-mono uppercase tracking-wider"
                  style={{
                    color: currentTheme === opt.id
                      ? "rgb(var(--rift-accent))"
                      : "rgb(var(--rift-muted) / 0.45)",
                  }}
                >
                  {opt.label}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}