declare const _default: {
    content: string[];
    theme: {
        extend: {
            colors: {
                rift: {
                    bg: string;
                    surface: string;
                    border: string;
                    accent: string;
                    accentDim: string;
                    text: string;
                    muted: string;
                    success: string;
                    error: string;
                    warning: string;
                };
            };
            fontFamily: {
                sans: [string, string, string];
                mono: [string, string];
            };
            animation: {
                "pulse-slow": string;
                "fade-in": string;
                "slide-up": string;
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
            };
        };
    };
    plugins: never[];
};
export default _default;
