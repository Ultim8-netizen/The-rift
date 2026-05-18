import { useState } from "react";
import { useRiftStore } from "@/store/riftStore";
import { useTransferActions } from "@/hooks/useTransfer";

export function TextTransferPanel() {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const selectedDevice = useRiftStore((s) => s.selectedDevice);
  const { sendText } = useTransferActions();

  const charCount = text.length;
  const canSend = text.trim().length > 0 && selectedDevice !== null && status !== "sending";

  async function handleSend() {
    if (!canSend) return;
    setStatus("sending");
    try {
      await sendText(text);
      setStatus("sent");
      setText("");
      // Reset status after 2 s so the button returns to idle
      setTimeout(() => setStatus("idle"), 2000);
    } catch {
      setStatus("error");
      setTimeout(() => setStatus("idle"), 3000);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl + Enter to send
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void handleSend();
    }
  }

  return (
    <div className="w-full max-w-md flex flex-col gap-3">
      <div className="relative">
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (status !== "idle") setStatus("idle");
          }}
          onKeyDown={handleKeyDown}
          placeholder="Type or paste text to send…"
          rows={7}
          className="
            w-full resize-none rounded-xl border border-rift-border bg-rift-surface
            text-rift-text text-sm font-mono placeholder-rift-muted/50
            px-4 py-3 pr-16 leading-relaxed
            focus:outline-none focus:border-rift-accent/60
            transition-colors duration-150
          "
        />
        <span className="absolute bottom-3 right-3 text-xs text-rift-muted/50 font-mono select-none pointer-events-none">
          {charCount}
        </span>
      </div>

      {selectedDevice ? (
        <p className="text-xs text-rift-muted font-mono -mt-1">
          Sending to{" "}
          <span className="text-rift-accent">{selectedDevice.name}</span>
          <span className="text-rift-muted/50"> · ⌘↵ to send</span>
        </p>
      ) : (
        <p className="text-xs text-rift-muted font-mono -mt-1">
          Select a device from the left panel
        </p>
      )}

      <button
        onClick={handleSend}
        disabled={!canSend}
        className={`
          px-8 py-3 rounded-lg font-mono text-sm font-semibold tracking-wide transition-all duration-150
          ${
            status === "sent"
              ? "bg-rift-success text-rift-bg cursor-default"
              : status === "error"
              ? "bg-rift-error text-rift-bg cursor-default"
              : canSend
              ? "bg-rift-accent text-rift-bg hover:bg-rift-accentDim shadow-[0_0_20px_rgba(0,200,255,0.3)] hover:shadow-[0_0_30px_rgba(0,200,255,0.4)]"
              : "bg-rift-border text-rift-muted cursor-not-allowed"
          }
        `}
      >
        {status === "sending"
          ? "SENDING…"
          : status === "sent"
          ? "SENT ✓"
          : status === "error"
          ? "FAILED ✗"
          : "SEND"}
      </button>
    </div>
  );
}