import { useEffect, useRef, useState } from "react";

const PHONE       = "+234-913-125-6817";
const PHONE_E164  = "+2349131256817";
const EMAIL       = "eldergod263@gmail.com";

async function openExternal(url: string) {
  try {
    // @ts-expect-error — @tauri-apps/plugin-opener is an optional runtime dep; falls back to window.open
    const mod = await import("@tauri-apps/plugin-opener").catch(() => null);
    if (mod) { await mod.open(url); return; }
  } catch { /* fall through */ }
  window.open(url, "_blank", "noopener,noreferrer");
}

interface Props { onClose: () => void }

export function ContactPanel({ onClose }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    }).catch(() => {});
  }

  return (
    <div
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
      className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in"
      style={{ background: "rgb(0 0 0 / 0.62)", backdropFilter: "blur(20px)" }}
    >
      <div
        className="glass-heavy animate-scale-in overflow-hidden"
        style={{ width: "300px", borderRadius: "28px" }}
      >
        {/* Accent bar */}
        <div style={{
          height: "3px",
          background: "linear-gradient(90deg, rgb(var(--rift-accent)), rgb(var(--rift-accent2)), transparent)",
          boxShadow: "0 0 24px rgb(var(--rift-glow) / 0.5)",
        }} />

        <div className="p-6">
          {/* Header */}
          <div className="flex items-start justify-between mb-5">
            <div>
              <p
                className="text-[9px] font-mono uppercase tracking-[0.22em] mb-1"
                style={{ color: "rgb(var(--rift-muted) / 0.5)" }}
              >
                Contact Us
              </p>
              <p className="font-semibold text-rift-text text-sm">Get in touch</p>
            </div>
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-full text-[11px] font-mono transition-all"
              style={{ background: "rgb(var(--rift-surface2) / 0.5)", color: "rgb(var(--rift-muted) / 0.55)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "rgb(var(--rift-text))"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "rgb(var(--rift-muted) / 0.55)"; }}
            >
              ✕
            </button>
          </div>

          {/* Phone / WhatsApp */}
          <div className="mb-4">
            <p
              className="text-[9px] font-mono uppercase tracking-[0.18em] mb-2"
              style={{ color: "rgb(var(--rift-muted) / 0.45)" }}
            >
              Phone / WhatsApp
            </p>
            <div
              className="flex items-center justify-between px-3 py-2.5 mb-2 rounded-2xl"
              style={{ background: "rgb(var(--rift-bg) / 0.45)", boxShadow: "inset 0 2px 8px rgb(0 0 0 / 0.2)" }}
            >
              <span className="text-xs font-mono text-rift-text">{PHONE}</span>
              <button
                onClick={() => copy(PHONE, "phone")}
                className="text-[9px] font-mono font-bold px-2 py-0.5 rounded-lg transition-all flex-shrink-0"
                style={{
                  color:      copied === "phone" ? "rgb(var(--rift-success))" : "rgb(var(--rift-accent) / 0.85)",
                  background: "rgb(var(--rift-accent) / 0.08)",
                  boxShadow:  "0 0 0 1px rgb(var(--rift-accent) / 0.18)",
                }}
              >
                {copied === "phone" ? "✓" : "COPY"}
              </button>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => openExternal(`https://wa.me/${PHONE_E164.replace("+", "")}`)}
                className="flex-1 py-2 text-[10px] font-mono font-bold btn-accent"
              >
                WhatsApp
              </button>
              <button
                onClick={() => openExternal(`tel:${PHONE_E164}`)}
                className="flex-1 py-2 text-[10px] font-mono btn-ghost"
              >
                Call
              </button>
              <button
                onClick={() => openExternal(`sms:${PHONE_E164}`)}
                className="flex-1 py-2 text-[10px] font-mono btn-ghost"
              >
                SMS
              </button>
            </div>
          </div>

          {/* Email */}
          <div>
            <p
              className="text-[9px] font-mono uppercase tracking-[0.18em] mb-2"
              style={{ color: "rgb(var(--rift-muted) / 0.45)" }}
            >
              Email
            </p>
            <div
              className="flex items-center justify-between px-3 py-2.5 mb-2 rounded-2xl"
              style={{ background: "rgb(var(--rift-bg) / 0.45)", boxShadow: "inset 0 2px 8px rgb(0 0 0 / 0.2)" }}
            >
              <span className="text-xs font-mono text-rift-text truncate pr-2">{EMAIL}</span>
              <button
                onClick={() => copy(EMAIL, "email")}
                className="text-[9px] font-mono font-bold px-2 py-0.5 rounded-lg flex-shrink-0 transition-all"
                style={{
                  color:      copied === "email" ? "rgb(var(--rift-success))" : "rgb(var(--rift-accent) / 0.85)",
                  background: "rgb(var(--rift-accent) / 0.08)",
                  boxShadow:  "0 0 0 1px rgb(var(--rift-accent) / 0.18)",
                }}
              >
                {copied === "email" ? "✓" : "COPY"}
              </button>
            </div>
            <button
              onClick={() => openExternal(`mailto:${EMAIL}`)}
              className="w-full py-2 text-[10px] font-mono btn-ghost"
            >
              Open in Mail App
            </button>
          </div>

          <p
            className="text-[9px] font-mono text-center mt-4"
            style={{ color: "rgb(var(--rift-muted) / 0.28)" }}
          >
            by abyssprotocol
          </p>
        </div>
      </div>
    </div>
  );
}