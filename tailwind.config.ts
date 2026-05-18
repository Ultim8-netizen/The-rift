import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        rift: {
          bg:        "rgb(var(--rift-bg) / <alpha-value>)",
          surface:   "rgb(var(--rift-surface) / <alpha-value>)",
          surface2:  "rgb(var(--rift-surface2) / <alpha-value>)",
          border:    "rgb(var(--rift-border) / <alpha-value>)",
          accent:    "rgb(var(--rift-accent) / <alpha-value>)",
          accentDim: "rgb(var(--rift-accent-dim) / <alpha-value>)",
          accent2:   "rgb(var(--rift-accent2) / <alpha-value>)",
          text:      "rgb(var(--rift-text) / <alpha-value>)",
          muted:     "rgb(var(--rift-muted) / <alpha-value>)",
          success:   "rgb(var(--rift-success) / <alpha-value>)",
          error:     "rgb(var(--rift-error) / <alpha-value>)",
          warning:   "rgb(var(--rift-warning) / <alpha-value>)",
          glow:      "rgb(var(--rift-glow) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      borderRadius: {
        "4xl": "2rem",
        "5xl": "2.5rem",
      },
      animation: {
        "pulse-slow":   "pulse 4s cubic-bezier(0.4,0,0.6,1) infinite",
        "fade-in":      "fadeIn 0.25s ease-out",
        "slide-up":     "slideUp 0.3s cubic-bezier(0.16,1,0.3,1)",
        "slide-down":   "slideDown 0.3s cubic-bezier(0.16,1,0.3,1)",
        "spin-slow":    "spin 22s linear infinite",
        "spin-slower":  "spin 36s linear infinite",
        "spin-slowest": "spin 50s linear infinite",
        "glow-pulse":   "glowPulse 3.5s ease-in-out infinite",
        "ring-breathe": "ringBreathe 5s ease-in-out infinite",
        "float":        "float 7s ease-in-out infinite",
        "radar":        "radar 2.5s ease-out infinite",
      },
      keyframes: {
        fadeIn: {
          "0%":   { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%":   { opacity: "0", transform: "translateY(14px) scale(0.98)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        slideDown: {
          "0%":   { opacity: "0", transform: "translateY(-10px) scale(0.98)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        glowPulse: {
          "0%,100%": { boxShadow: "0 0 14px rgb(var(--rift-glow) / 0.18)" },
          "50%":     { boxShadow: "0 0 34px rgb(var(--rift-glow) / 0.44)" },
        },
        ringBreathe: {
          "0%,100%": { opacity: "0.25", transform: "scale(1)" },
          "50%":     { opacity: "0.60", transform: "scale(1.05)" },
        },
        float: {
          "0%,100%": { transform: "translateY(0px)" },
          "50%":     { transform: "translateY(-7px)" },
        },
        radar: {
          "0%":   { transform: "scale(0.5)", opacity: "0.7" },
          "100%": { transform: "scale(2.5)", opacity: "0" },
        },
      },
      boxShadow: {
        "glow-sm": "0 0 10px rgb(var(--rift-glow) / 0.18)",
        "glow":    "0 0 22px rgb(var(--rift-glow) / 0.28)",
        "glow-lg": "0 0 46px rgb(var(--rift-glow) / 0.34)",
        "glass":   "0 8px 32px rgb(0 0 0 / 0.28), 0 2px 8px rgb(0 0 0 / 0.14)",
        "glass-sm":"0 4px 16px rgb(0 0 0 / 0.18), 0 1px 4px rgb(0 0 0 / 0.10)",
      },
    },
  },
  plugins: [],
} satisfies Config;