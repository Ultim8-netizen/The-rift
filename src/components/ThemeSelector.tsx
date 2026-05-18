import { useEffect, useRef } from "react";
import { useRiftStore } from "@/store/riftStore";
import { setAndPersistTheme } from "@/hooks/useTheme";
import type { ThemeId } from "@/types";

interface ThemeOption {
  id: ThemeId;
  label: string;
  bg: string;
  accent: string;
  ring: string;
}

const DARK_OPTIONS: ThemeOption[] = [
  { id: "dark-black",  label: "Void",    bg: "#08080e", accent: "#00c8ff", ring: "#00c8ff40" },
  { id: "dark-blue",   label: "Abyss",   bg: "#04081e", accent: "#60b6ff", ring: "#60b6ff40" },
  { id: "dark-grey",   label: "Slate",   bg: "#0b0b0e", accent: "#bcc2d2", ring: "#bcc2d240" },
  { id: "dark-purple", label: "Cosmos",  bg: "#080416", accent: "#c06cff", ring: "#c06cff40" },
];

const LIGHT_OPTIONS: ThemeOption[] = [
  { id: "light-pink",  label: "Rose",    bg: "#fff2fa", accent: "#d03e8a", ring: "#d03e8a40" },
  { id: "light-lemon", label: "Citrus",  bg: "#ffffe6", accent: "#918700", ring: "#91870040" },
  { id: "light-blue",  label: "Sky",     bg: "#e6f2ff", accent: "#1270d6", ring: "#1270d640" },
];

function Swatch({ opt, active, onSelect }: { opt: ThemeOption; active: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className="flex flex-col items-center gap-1.5 group"
      title={opt.label}
    >
      <div
        className="relative w-10 h-10 rounded-2xl transition-transform duration-150 group-hover:scale-110"
        style={{
          background: opt.bg,
          boxShadow: active
            ? `0 0 0 2px ${opt.accent}, 0 0 14px ${opt.ring}`
            : `0 0 0 1px ${opt.ring}`,
        }}
      >
        {/* Accent dot preview */}
        <span
          className="absolute bottom-1.5 right-1.5 w-2 h-2 rounded-full"
          style={{ background: opt.accent }}
        />
        {active && (
          <span
            className="absolute top-1 left-1 text-[8px] font-mono font-bold"
            style={{ color: opt.accent }}
          >
            ✓
          </span>
        )}
      </div>
      <span className="text-[9px] font-mono text-rift-muted group-hover:text-rift-text transition-colors tracking-wide uppercase">
        {opt.label}
      </span>
    </button>
  );
}

export function ThemeSelector() {
  const open = useRiftStore((s) => s.themePickerOpen);
  const setOpen = useRiftStore((s) => s.setThemePickerOpen);
  const currentTheme = useRiftStore((s) => s.theme);
  const setTheme = useRiftStore((s) => s.setTheme);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
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
    <div className="fixed bottom-12 right-3 z-50 animate-slide-up">
      <div
        ref={panelRef}
        className="glass-heavy rounded-2xl p-4 shadow-glass w-72"
        style={{ border: "1px solid rgb(var(--rift-border) / 0.6)" }}
      >
        {/* System option */}
        <button
          onClick={() => select("system")}
          className={`
            w-full flex items-center justify-between px-3 py-2 rounded-xl mb-3 text-xs font-mono
            transition-all duration-150
            ${currentTheme === "system"
              ? "bg-rift-accent/15 text-rift-accent border border-rift-accent/30"
              : "text-rift-muted hover:bg-rift-surface2 hover:text-rift-text border border-transparent"}
          `}
        >
          <span className="uppercase tracking-widest">Auto / System</span>
          {currentTheme === "system" && <span className="text-rift-accent">✓</span>}
        </button>

        {/* Dark group */}
        <p className="text-[9px] font-mono text-rift-muted/60 uppercase tracking-[0.2em] mb-2.5">
          Dark
        </p>
        <div className="flex gap-4 justify-start mb-4">
          {DARK_OPTIONS.map((opt) => (
            <Swatch
              key={opt.id}
              opt={opt}
              active={currentTheme === opt.id}
              onSelect={() => select(opt.id)}
            />
          ))}
        </div>

        {/* Light group */}
        <p className="text-[9px] font-mono text-rift-muted/60 uppercase tracking-[0.2em] mb-2.5">
          Light
        </p>
        <div className="flex gap-4 justify-start">
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