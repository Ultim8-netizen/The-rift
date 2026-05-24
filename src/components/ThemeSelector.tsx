import { useEffect, useRef } from "react";
import { useRiftStore } from "@/store/riftStore";
import { setAndPersistTheme } from "@/hooks/useTheme";
import type { ThemeId } from "@/types";

interface ThemeOption {
  id: ThemeId;
  label: string;
  bg: string;
  accent: string;
}

const DARK_OPTIONS: ThemeOption[] = [
  { id: "dark-black",  label: "Void",   bg: "#08080e", accent: "#00c8ff" },
  { id: "dark-blue",   label: "Abyss",  bg: "#04081e", accent: "#60b6ff" },
  { id: "dark-grey",   label: "Slate",  bg: "#0b0b0e", accent: "#bcc2d2" },
  { id: "dark-purple", label: "Cosmos", bg: "#080416", accent: "#c06cff" },
];

const LIGHT_OPTIONS: ThemeOption[] = [
  { id: "light-pink",  label: "Rose",   bg: "#fff2fa", accent: "#d03e8a" },
  { id: "light-lemon", label: "Citrus", bg: "#ffffe6", accent: "#918700" },
  { id: "light-blue",  label: "Sky",    bg: "#e6f2ff", accent: "#1270d6" },
];

function Swatch({ opt, active, onSelect }: {
  opt: ThemeOption;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className="flex flex-col items-center gap-1.5 group"
      title={opt.label}
    >
      <div
        className="relative w-10 h-10 rounded-2xl transition-all duration-200 group-hover:scale-110"
        style={{
          background: opt.bg,
          boxShadow: active
            ? `0 0 0 2px ${opt.accent}, 0 0 20px ${opt.accent}44, 0 4px 12px rgba(0,0,0,0.4)`
            : `0 0 0 1px ${opt.accent}30, 0 2px 8px rgba(0,0,0,0.3)`,
        }}
      >
        {/* Accent preview dot */}
        <span
          className="absolute bottom-1.5 right-1.5 w-2 h-2 rounded-full"
          style={{
            background: opt.accent,
            boxShadow: `0 0 6px ${opt.accent}80`,
          }}
        />
        {active && (
          <span
            className="absolute top-1 left-1.5 text-[9px] font-mono font-bold"
            style={{ color: opt.accent }}
          >
            ✓
          </span>
        )}
      </div>
      <span
        className="text-[9px] font-mono uppercase tracking-wider transition-colors"
        style={{
          color: active
            ? "rgb(var(--rift-accent))"
            : "rgb(var(--rift-muted) / 0.6)",
        }}
      >
        {opt.label}
      </span>
    </button>
  );
}

export function ThemeSelector() {
  const open         = useRiftStore((s) => s.themePickerOpen);
  const setOpen      = useRiftStore((s) => s.setThemePickerOpen);
  const currentTheme = useRiftStore((s) => s.theme);
  const setTheme     = useRiftStore((s) => s.setTheme);
  const panelRef     = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [open, setOpen]);

  if (!open) return null;

  function select(id: ThemeId) {
    setAndPersistTheme(id);
    setTheme(id);
    setOpen(false);
  }

  return (
    <div
      className="fixed bottom-16 right-4 z-50 animate-slide-up"
      style={{ zIndex: 60 }}
    >
      <div
        ref={panelRef}
        className="glass-heavy p-5"
        style={{
          borderRadius: "24px",
          width: "288px",
        }}
      >
        {/* System option */}
        <button
          onClick={() => select("system")}
          className="w-full flex items-center justify-between px-3 py-2 rounded-2xl mb-4 text-xs font-mono transition-all duration-150"
          style={{
            background: currentTheme === "system"
              ? "rgb(var(--rift-accent) / 0.1)"
              : "rgb(255 255 255 / 0.03)",
            color: currentTheme === "system"
              ? "rgb(var(--rift-accent))"
              : "rgb(var(--rift-muted) / 0.7)",
            boxShadow: currentTheme === "system"
              ? "0 0 0 1px rgb(var(--rift-accent) / 0.25), 0 0 16px rgb(var(--rift-glow) / 0.1)"
              : "0 0 0 1px rgb(255 255 255 / 0.05)",
          }}
        >
          <span className="uppercase tracking-widest text-[10px]">Auto / System</span>
          {currentTheme === "system" && (
            <span style={{ color: "rgb(var(--rift-accent))" }}>✓</span>
          )}
        </button>

        {/* Dark group */}
        <p
          className="text-[9px] font-mono uppercase tracking-[0.22em] mb-3"
          style={{ color: "rgb(var(--rift-muted) / 0.5)" }}
        >
          Dark
        </p>
        <div className="flex gap-3 justify-between mb-5">
          {DARK_OPTIONS.map((opt) => (
            <Swatch
              key={opt.id}
              opt={opt}
              active={currentTheme === opt.id}
              onSelect={() => select(opt.id)}
            />
          ))}
        </div>

        {/* Gradient separator */}
        <div
          className="mb-4"
          style={{
            height: "1px",
            background: "linear-gradient(90deg, transparent, rgb(var(--rift-muted) / 0.15), transparent)",
          }}
        />

        {/* Light group */}
        <p
          className="text-[9px] font-mono uppercase tracking-[0.22em] mb-3"
          style={{ color: "rgb(var(--rift-muted) / 0.5)" }}
        >
          Light
        </p>
        <div className="flex gap-3 justify-start">
          {LIGHT_OPTIONS.map((opt) => (
            <Swatch
              key={opt.id}
              opt={opt}
              active={currentTheme === opt.id}
              onSelect={() => select(opt.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}