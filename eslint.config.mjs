import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The Next.js config registers jsx-a11y but enables only a few of its rules;
  // turn on the full recommended set (rules only, so the plugin isn't redefined).
  {
    files: ["**/*.{js,jsx,mjs,ts,tsx}"],
    rules: jsxA11y.flatConfigs.recommended.rules,
  },
  // Disable stylistic rules that conflict with Prettier. Keep this last.
  prettier,
  globalIgnores([".next/**", "out/**", "build/**", "coverage/**", "next-env.d.ts"]),
]);

export default eslintConfig;
