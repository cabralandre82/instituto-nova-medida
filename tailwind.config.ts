import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        cream: {
          50: "#FDFBF7",
          100: "#FAF7F2",
          200: "#F4EFE6",
          300: "#E8DFD3",
        },
        sage: {
          50: "#EEF2EF",
          100: "#D9E1DB",
          200: "#B0BFB4",
          300: "#869C8E",
          400: "#6F8979",
          500: "#5C7A6A",
          600: "#4A6354",
          700: "#3B4F44",
          800: "#2E3D35",
          900: "#1F2A24",
        },
        terracotta: {
          50: "#FBF2EE",
          100: "#F5E0D5",
          200: "#EDC2AE",
          300: "#E0A185",
          400: "#D38966",
          500: "#C97B5E",
          600: "#B0654C",
          700: "#8C4F3B",
          800: "#6A3C2D",
        },
        ink: {
          50: "#F7F6F4",
          100: "#E8E6E1",
          200: "#C9C6BF",
          300: "#9C988F",
          400: "#6E6A60",
          500: "#4A463E",
          600: "#363229",
          700: "#2A2620",
          800: "#1C1A16",
          900: "#0F0E0B",
        },
      },
      fontFamily: {
        serif: ["var(--font-fraunces)", "Georgia", "serif"],
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      maxWidth: {
        "8xl": "88rem",
      },
      animation: {
        "fade-up": "fadeUp 0.7s ease-out forwards",
        "fade-in": "fadeIn 0.6s ease-out forwards",
        shimmer: "shimmer 2.5s linear infinite",
      },
      keyframes: {
        fadeUp: {
          "0%": { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
