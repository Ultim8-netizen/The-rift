export default {
    content: ["./index.html", "./src/**/*.{ts,tsx}"],
    theme: {
        extend: {
            colors: {
                rift: {
                    bg: "rgb(var(--rift-bg) / <alpha-value>)",
                    surface: "rgb(var(--rift-surface) / <alpha-value>)",
                    surface2: "rgb(var(--rift-surface2) / <alpha-value>)",
                    border: "rgb(var(--rift-border) / <alpha-value>)",
                    accent: "rgb(var(--rift-accent) / <alpha-value>)",
                    accentDim: "rgb(var(--rift-accent-dim) / <alpha-value>)",
                    accent2: "rgb(var(--rift-accent2) / <alpha-value>)",
                    text: "rgb(var(--rift-text) / <alpha-value>)",
                    muted: "rgb(var(--rift-muted) / <alpha-value>)",
                    success: "rgb(var(--rift-success) / <alpha-value>)",
                    error: "rgb(var(--rift-error) / <alpha-value>)",
                    warning: "rgb(var(--rift-warning) / <alpha-value>)",
                    glow: "rgb(var(--rift-glow) / <alpha-value>)",
                },
            },
            fontFamily: {
                sans: ["Inter", "system-ui", "sans-serif"],
                mono: ["JetBrains Mono", "Fira Code", "monospace"],
            },
            borderRadius: {
                "4xl": "2rem",
                "5xl": "2.5rem",
                "6xl": "3rem",
            },
            animation: {
                "pulse-slow": "pulse 4s cubic-bezier(0.4,0,0.6,1) infinite",
                "fade-in": "fadeIn 0.3s ease-out",
                "slide-up": "slideUp 0.35s cubic-bezier(0.16,1,0.3,1)",
                "slide-down": "slideDown 0.35s cubic-bezier(0.16,1,0.3,1)",
                "spin-slow": "spin 24s linear infinite",
                "spin-slower": "spin 40s linear infinite",
                "spin-slowest": "spin 60s linear infinite",
                "glow-pulse": "glowPulse 3.5s ease-in-out infinite",
                "ring-breathe": "ringBreathe 6s ease-in-out infinite",
                "float": "float 8s ease-in-out infinite",
                "radar": "radar 2.8s ease-out infinite",
                "orb-drift-a": "orbDriftA 22s ease-in-out infinite alternate",
                "orb-drift-b": "orbDriftB 30s ease-in-out infinite alternate",
                "orb-drift-c": "orbDriftC 18s ease-in-out infinite alternate",
                "conic-spin": "conicSpin 6s linear infinite",
                "conic-spin-r": "conicSpinR 9s linear infinite",
                "scale-in": "scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)",
            },
            keyframes: {
                fadeIn: { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
                scaleIn: { "0%": { opacity: "0", transform: "scale(0.92)" }, "100%": { opacity: "1", transform: "scale(1)" } },
                slideUp: {
                    "0%": { opacity: "0", transform: "translateY(18px) scale(0.97)" },
                    "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
                },
                slideDown: {
                    "0%": { opacity: "0", transform: "translateY(-12px) scale(0.97)" },
                    "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
                },
                glowPulse: {
                    "0%,100%": { boxShadow: "0 0 18px rgb(var(--rift-glow) / 0.22)" },
                    "50%": { boxShadow: "0 0 42px rgb(var(--rift-glow) / 0.55)" },
                },
                ringBreathe: {
                    "0%,100%": { opacity: "0.3", transform: "scale(1)" },
                    "50%": { opacity: "0.65", transform: "scale(1.06)" },
                },
                float: {
                    "0%,100%": { transform: "translateY(0px)" },
                    "50%": { transform: "translateY(-8px)" },
                },
                radar: {
                    "0%": { transform: "scale(0.4)", opacity: "0.7" },
                    "100%": { transform: "scale(2.8)", opacity: "0" },
                },
                orbDriftA: {
                    "0%": { transform: "translate(0%, 0%) scale(1)" },
                    "100%": { transform: "translate(8%, 12%) scale(1.15)" },
                },
                orbDriftB: {
                    "0%": { transform: "translate(0%, 0%) scale(1)" },
                    "100%": { transform: "translate(-10%, -8%) scale(1.2)" },
                },
                orbDriftC: {
                    "0%": { transform: "translate(0%, 0%) scale(1)" },
                    "100%": { transform: "translate(5%, -10%) scale(0.9)" },
                },
                conicSpin: {
                    "0%": { "--conic-angle": "0deg" },
                    "100%": { "--conic-angle": "360deg" },
                },
                conicSpinR: {
                    "0%": { "--conic-angle": "360deg" },
                    "100%": { "--conic-angle": "0deg" },
                },
            },
            boxShadow: {
                // Elevation system — no borders, pure shadow
                "e1": "0 1px 4px rgb(0 0 0 / 0.35), 0 0 0 1px rgb(255 255 255 / 0.04), inset 0 1px 0 rgb(255 255 255 / 0.05)",
                "e2": "0 4px 16px rgb(0 0 0 / 0.4), 0 1px 4px rgb(0 0 0 / 0.3), 0 0 0 1px rgb(255 255 255 / 0.04), inset 0 1px 0 rgb(255 255 255 / 0.06)",
                "e3": "0 8px 32px rgb(0 0 0 / 0.5), 0 2px 8px rgb(0 0 0 / 0.35), 0 0 0 1px rgb(255 255 255 / 0.05), inset 0 1px 0 rgb(255 255 255 / 0.07)",
                "e4": "0 20px 60px rgb(0 0 0 / 0.6), 0 8px 20px rgb(0 0 0 / 0.4), 0 0 0 1px rgb(255 255 255 / 0.06), inset 0 1px 0 rgb(255 255 255 / 0.08)",
                // Glow variants
                "glow-sm": "0 0 12px rgb(var(--rift-glow) / 0.2)",
                "glow": "0 0 28px rgb(var(--rift-glow) / 0.3)",
                "glow-lg": "0 0 56px rgb(var(--rift-glow) / 0.4)",
                "glow-ring": "0 0 0 1px rgb(var(--rift-accent) / 0.4), 0 0 24px rgb(var(--rift-glow) / 0.25)",
                // Combined
                "glass-sm": "0 4px 16px rgb(0 0 0 / 0.2), 0 1px 4px rgb(0 0 0 / 0.15)",
                "glass": "0 8px 32px rgb(0 0 0 / 0.3), 0 2px 8px rgb(0 0 0 / 0.2)",
            },
        },
    },
    plugins: [],
};
