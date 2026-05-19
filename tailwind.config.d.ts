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
            };
            boxShadow: {
                "glow-sm": string;
                glow: string;
                "glow-lg": string;
                glass: string;
                "glass-sm": string;
            };
        };
    };
    plugins: never[];
};
export default _default;
