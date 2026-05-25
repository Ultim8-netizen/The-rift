import { useCallback, useEffect, useRef, useState } from "react";
import { useRiftStore } from "@/store/riftStore";
import { useTransferActions } from "@/hooks/useTransfer";

// Folded corner size in px — used in both the SVG clip and the fold triangle
const FOLD = 28;

export function TextTransferPanel() {
  const open          = useRiftStore((s) => s.stickyNoteOpen);
  const setOpen       = useRiftStore((s) => s.setStickyNoteOpen);
  const selectedDevice = useRiftStore((s) => s.selectedDevice);

  const [text, setText]     = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const textareaRef         = useRef<HTMLTextAreaElement>(null);
  const { sendText }        = useTransferActions();

  const charCount = text.length;
  const canSend   = text.trim().length > 0 && selectedDevice !== null && status !== "sending";

  // Focus textarea when panel opens
  useEffect(() => {
    if (open) setTimeout(() => textareaRef.current?.focus(), 60);
  }, [open]);

  // Escape closes
  useEffect(() => {
    if (!open) return;
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [open, setOpen]);

  const handlePaste = useCallback(async () => {
    try {
      const t = await navigator.clipboard.readText();
      setText((prev) => prev + t);
      textareaRef.current?.focus();
    } catch { /* permission denied — silent */ }
  }, []);

  async function handleSend() {
    if (!canSend) return;
    setStatus("sending");
    try {
      await sendText(text);
      setStatus("sent");
      setText("");
      setTimeout(() => setStatus("idle"), 2200);
    } catch {
      setStatus("error");
      setTimeout(() => setStatus("idle"), 3000);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void handleSend();
    }
  }

  if (!open) return null;

  // ── theme-aware note colour ───────────────────────────────────────────────
  const dataTheme = document.documentElement.getAttribute("data-theme") ?? "";
  const isLight   = dataTheme.startsWith("light");

  const noteBase   = isLight ? "255 248 210"   : "38  36  18";
  const noteFold   = isLight ? "225 210 140"   : "22  20   8";
  const noteLines  = isLight ? "200 185 120"   : "60  56  28";
  const noteShadow = isLight
    ? "0 8px 40px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.12)"
    : "0 8px 48px rgba(0,0,0,0.65), 0 2px 12px rgba(0,0,0,0.5)";
  const textColor  = isLight ? "rgb(44 36 8)"  : "rgb(238 228 180)";
  const mutedColor = isLight ? "rgba(100,80,20,0.55)" : "rgba(200,180,100,0.45)";

  const W = 320;
  const H = 380;

  return (
    // Backdrop — click outside closes
    <div
      onClick={() => setOpen(false)}
      className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in"
      style={{ background: "rgb(0 0 0 / 0.45)", backdropFilter: "blur(10px)" }}
    >
      {/* Note card — stop propagation so clicks inside don't close */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative animate-scale-in select-none"
        style={{ width: W, height: H, filter: `drop-shadow(${noteShadow.split(",")[0]})` }}  // ← fix: noteShadow applied
      >
        {/* ── Paper body with SVG clip for folded corner ── */}
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          className="absolute inset-0"
          style={{ overflow: "visible" }}
        >
          <defs>
            <clipPath id="note-clip">
              {/* Rectangle minus the top-right folded corner */}
              <polygon
                points={`
                  0,0
                  ${W - FOLD},0
                  ${W},${FOLD}
                  ${W},${H}
                  0,${H}
                `}
              />
            </clipPath>
            {/* Subtle ruled-line pattern */}
            <pattern id="lines" x="0" y="0" width={W} height="28" patternUnits="userSpaceOnUse">
              <line
                x1="0" y1="27.5" x2={W} y2="27.5"
                stroke={`rgb(${noteLines})`}
                strokeWidth="0.6"
                strokeOpacity="0.45"
              />
            </pattern>
          </defs>

          {/* Drop shadow underneath */}
          <polygon
            points={`
              2,2
              ${W - FOLD + 2},2
              ${W + 2},${FOLD + 2}
              ${W + 2},${H + 2}
              2,${H + 2}
            `}
            fill="rgba(0,0,0,0.28)"
            style={{ filter: "blur(6px)" }}
          />

          {/* Note body */}
          <polygon
            points={`
              0,0
              ${W - FOLD},0
              ${W},${FOLD}
              ${W},${H}
              0,${H}
            `}
            fill={`rgb(${noteBase})`}
          />

          {/* Ruled lines overlay */}
          <polygon
            points={`
              0,0
              ${W - FOLD},0
              ${W},${FOLD}
              ${W},${H}
              0,${H}
            `}
            fill="url(#lines)"
          />

          {/* Fold triangle — darker paper underside */}
          <polygon
            points={`${W - FOLD},0 ${W},${FOLD} ${W - FOLD},${FOLD}`}
            fill={`rgb(${noteFold})`}
          />

          {/* Fold crease line */}
          <line
            x1={W - FOLD} y1="0"
            x2={W}        y2={FOLD}
            stroke={`rgb(${noteLines})`}
            strokeWidth="0.8"
            strokeOpacity="0.6"
          />

          {/* Left margin red line — classic notebook look */}
          <line
            x1="44" y1="0"
            x2="44" y2={H}
            stroke="rgba(220,80,80,0.25)"
            strokeWidth="1"
          />
        </svg>

        {/* ── Content layer ── */}
        <div
          className="absolute inset-0 flex flex-col"
          style={{ padding: "14px 14px 14px 52px" }}
        >
          {/* Header row */}
          <div className="flex items-center justify-between mb-2 flex-shrink-0">
            <span
              className="text-[9px] font-mono font-bold uppercase tracking-[0.22em]"
              style={{ color: mutedColor }}
            >
              Quick Note
            </span>
            <button
              onClick={() => setOpen(false)}
              className="w-5 h-5 flex items-center justify-center rounded-full transition-opacity opacity-40 hover:opacity-80"
              style={{ color: textColor, fontSize: "10px", marginRight: "18px" }}
            >
              ✕
            </button>
          </div>

          {/* Target device */}
          <div className="flex-shrink-0 mb-2">
            {selectedDevice ? (
              <p
                className="text-[10px] font-mono truncate"
                style={{ color: mutedColor }}
              >
                → <span style={{ color: textColor, fontWeight: 600 }}>{selectedDevice.name}</span>
              </p>
            ) : (
              <p
                className="text-[10px] font-mono"
                style={{ color: "rgba(200,80,80,0.7)" }}
              >
                No device selected
              </p>
            )}
          </div>

          {/* Textarea — fills remaining space */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (status !== "idle") setStatus("idle");
            }}
            onKeyDown={handleKey}
            placeholder="Type or paste here…"
            className="flex-1 w-full resize-none bg-transparent outline-none font-mono text-[12px] leading-[28px] placeholder-opacity-40"
            style={{
              color: textColor,
              caretColor: textColor,
              lineHeight: "28px",
              paddingTop: "1px",
            }}
            spellCheck={false}
          />

          {/* Footer */}
          <div
            className="flex items-center justify-between flex-shrink-0 pt-2"
            style={{ marginRight: "18px" }}
          >
            {/* Char count + paste */}
            <div className="flex items-center gap-2">
              <span
                className="text-[9px] font-mono"
                style={{ color: mutedColor }}
              >
                {charCount}
              </span>
              <button
                onClick={handlePaste}
                className="text-[9px] font-mono px-2 py-0.5 rounded transition-opacity opacity-50 hover:opacity-90"
                style={{
                  color: textColor,
                  background: `rgba(0,0,0,${isLight ? "0.07" : "0.25"})`,
                  boxShadow: `0 0 0 1px rgba(0,0,0,${isLight ? "0.1" : "0.3"})`,
                }}
              >
                PASTE
              </button>
            </div>

            {/* Send button */}
            <button
              onClick={handleSend}
              disabled={!canSend}
              className="text-[10px] font-mono font-bold px-4 py-1.5 rounded-full transition-all duration-150"
              style={{
                background: status === "sent"
                  ? "rgba(34,200,100,0.85)"
                  : status === "error"
                  ? "rgba(220,60,60,0.8)"
                  : canSend
                  ? `rgb(var(--rift-accent))`
                  : `rgba(0,0,0,${isLight ? "0.12" : "0.3"})`,
                color: canSend || status !== "idle"
                  ? (isLight ? "rgb(255,255,255)" : "rgb(10,10,20)")
                  : mutedColor,
                boxShadow: canSend && status === "idle"
                  ? "0 0 14px rgb(var(--rift-glow) / 0.4)"
                  : "none",
                opacity: !canSend && status === "idle" ? 0.45 : 1,
                cursor: !canSend && status === "idle" ? "not-allowed" : "pointer",
                letterSpacing: "0.1em",
              }}
            >
              {status === "sending" ? "…"
               : status === "sent"  ? "SENT ✓"
               : status === "error" ? "FAILED"
               : "SEND"}
            </button>
          </div>

          {/* ⌘↵ hint */}
          <p
            className="text-[8px] font-mono text-right flex-shrink-0 mt-0.5"
            style={{ color: mutedColor, marginRight: "18px" }}
          >
            ⌘↵ to send
          </p>
        </div>
      </div>
    </div>
  );
}