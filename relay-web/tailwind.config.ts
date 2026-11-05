import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // touch:… applies on touch screens (bigger tap targets there, DESIGN.md §8).
      screens: { touch: { raw: "(pointer: coarse)" } },
      colors: { "on-accent": "var(--on-accent)" },
    },
  },
  plugins: [],
};

export default config;
