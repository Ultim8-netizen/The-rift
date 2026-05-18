import { useEffect, useRef, useState } from "react";
import { useRiftStore } from "@/store/riftStore";

export function IncomingTextDialog() {
  const payload = useRiftStore((s) => s.incomingText);
  const setIncomingText = useRiftStore((s) => s.setIncomingText);
  const [copied, setCopied] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!payload) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIncomingText(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [payload, setIncomingText]);

  if (!payload) return null;

  async function handleCopy() {
    await navigator.clipboard.writeText(payload!.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const lineCount = payload.text.split("\n").length;
  const charCount = payload.text.length;

  return (
    <div
      ref={overlayRef}
      onClick={(e) => {
        if (e.target === overlayRef.current) setIncomingText(null);
      }}
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
    >
      <div className="bg-rift-surface border border-rift-border rounded-2xl w-[420px] max-w-[90vw] shadow-2xl shadow-black/50 animate-slide-up overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-rift-border flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-mono text-rift-muted uppercase tracking-widest mb-1">
              Incoming Text
            </p>
            <p className="text-rift-text font-semibold text-sm">
              {payload.senderDevice.name}
            </p>
          </div>
          <span className="text-xs font-mono text-rift-muted/60 mt-1 shrink-0">
            {charCount} chars · {lineCount} line{lineCount !== 1 ? "s" : ""}
          </span>
        </div>

        {/* Text body — scrollable, max ~8 lines before scroll */}
        <div className="px-5 py-4 max-h-64 overflow-y-auto">
          <pre className="text-sm text-rift-text font-mono whitespace-pre-wrap break-words leading-relaxed">
            {payload.text}
          </pre>
        </div>

        {/* Actions */}
        <div className="px-5 pb-5 pt-1 flex flex-col gap-2 border-t border-rift-border mt-1">
          <button
            onClick={handleCopy}
            className={`
              w-full py-2.5 rounded-lg font-mono text-sm font-semibold tracking-wide transition-all duration-150
              ${
                copied
                  ? "bg-rift-success text-rift-bg"
                  : "bg-rift-accent text-rift-bg hover:bg-rift-accentDim shadow-[0_0_16px_rgba(0,200,255,0.2)]"
              }
            `}
          >
            {copied ? "COPIED ✓" : "COPY TO CLIPBOARD"}
          </button>
          <button
            onClick={() => setIncomingText(null)}
            className="w-full py-2 rounded-lg border border-rift-border text-rift-muted text-xs font-mono hover:border-rift-accent/40 hover:text-rift-accent transition-colors"
          >
            DISMISS
          </button>
        </div>
      </div>
    </div>
  );
}