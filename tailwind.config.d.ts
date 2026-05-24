declare const _default: {
    content: string[];
    theme: {
        extend: {
            colors: {
                rift: {
                    bg: string;
                    surface: string;
                    surface2: string;
                    border: string;
                    accent: string;
                    accentDim: string;
                    accent2: string;
                    text: string;
                    muted: string;
                    success: string;
                    error: string;
                    warning: string;
                    glow: string;
                };
            };
            fontFamily: {
                sans: [string, string, string];
                mono: [string, string, string];
            };
            borderRadius: {
                "4xl": string;
                "5xl": string;
                "6xl": string;
            };
            animation: {
                "pulse-slow": string;
                "fade-in": string;
                "slide-up": string;
                "slide-down": string;
                "spin-slow": string;
                "spin-slower": string;
                "spin-slowest": string;
                "glow-pulse": string;
                "ring-breathe": string;
                float: string;
                radar: string;
                "orb-drift-a": string;
                "orb-drift-b": string;
                "orb-drift-c": string;
                "conic-spin": string;
                "conic-spin-r": string;
                "scale-in": string;
            };
            keyframes: {
                fadeIn: {
                    "0%": {
                        opacity: string;
                    };
                    "100%": {
                        opacity: string;
                    };
                };
                scaleIn: {
                    "0%": {
                        opacity: string;
                        transform: string;
                    };
                    "100%": {
                        opacity: string;
                        transform: string;
                    };
                };
                slideUp: {
                    "0%": {
                        opacity: string;
                        transform: string;
                    };
                    "100%": {
                        opacity: string;
                        transform: string;
                    };
                };
                slideDown: {
                    "0%": {
                        opacity: string;
                        transform: string;
                    };
                    "100%": {
                        opacity: string;
                        transform: string;
                    };
                };
                glowPulse: {
                    "0%,100%": {
                        boxShadow: string;
                    };
                    "50%": {
                        boxShadow: string;
                    };
                };
                ringBreathe: {
                    "0%,100%": {
                        opacity: string;
                        transform: string;
                    };
                    "50%": {
                        opacity: string;
                        transform: string;
                    };
                };
                float: {
                    "0%,100%": {
                        transform: string;
                    };
                    "50%": {
                        transform: string;
                    };
                };
                radar: {
                    "0%": {
                        transform: string;
                        opacity: string;
                    };
                    "100%": {
                        transform: string;
                        opacity: string;
                    };
                };
                orbDriftA: {
                    "0%": {
                        transform: string;
                    };
                    "100%": {
                        transform: string;
                    };
                };
                orbDriftB: {
                    "0%": {
                        transform: string;
                    };
                    "100%": {
                        transform: string;
                    };
                };
                orbDriftC: {
                    "0%": {
                        transform: string;
                    };
                    "100%": {
                        transform: string;
                    };
                };
                conicSpin: {
                    "0%": Record<string, string>;
                    "100%": Record<string, string>;
                };
                conicSpinR: {
                    "0%": Record<string, string>;
                    "100%": Record<string, string>;
                };
            };
            boxShadow: {
                e1: string;
                e2: string;
                e3: string;
                e4: string;
                "glow-sm": string;
                glow: string;
                "glow-lg": string;
                "glow-ring": string;
                "glass-sm": string;
                glass: string;
            };
        };
    };
    plugins: never[];
};
export default _default;
