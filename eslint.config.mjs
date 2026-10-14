import { builtinModules } from "node:module";

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
  // Demo code is written by the coding agent: no environment, Node APIs,
  // network calls, server code or injected HTML (see AGENTS.md). These rules
  // catch the common forms; they aren't a security boundary on their own (CI
  // also checks which files and what kind of text an agent pull request adds).
  {
    files: ["src/app/demos/**/*.{ts,tsx}"],
    // An inline `eslint-disable` must not switch these rules off.
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "next/navigation",
              importNames: ["redirect", "permanentRedirect"],
              message: "Demo code can't redirect.",
            },
          ],
          patterns: [
            {
              group: ["node:*", ...builtinModules, ...builtinModules.map((name) => `${name}/*`)],
              message: "Demo code can't use Node APIs.",
            },
            {
              group: ["next/headers", "next/script", "next/server", "next/dist/*", "server-only"],
              message: "Demo code can't use server-only APIs or external scripts.",
            },
            {
              // Only the shared UI primitives and helpers, and the demo's own files.
              regex: "^(@/(?!components/ui/[a-z0-9-]+$|lib/utils$)|\\.\\./)",
              message:
                "Demo code may import only @/components/ui/*, @/lib/utils and its own files.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...[
          "fetch",
          "XMLHttpRequest",
          "WebSocket",
          "EventSource",
          "Image",
          "Worker",
          "SharedWorker",
          "importScripts",
        ].map((name) => ({
          name,
          message: "Demo code can't make network calls or load resources.",
        })),
        ...["open", "top", "parent", "frames", "opener"].map((name) => ({
          name,
          message: "Demo code can't open or reach other windows.",
        })),
        ...["eval", "Function"].map((name) => ({
          name,
          message: "Demo code can't evaluate strings as code.",
        })),
        ...["process", "require", "module", "exports", "global"].map((name) => ({
          name,
          message: "Demo code can't read the environment or load modules.",
        })),
      ],
      "no-restricted-properties": [
        "error",
        ...["window", "self", "globalThis"].flatMap((object) =>
          [
            "fetch",
            "XMLHttpRequest",
            "WebSocket",
            "EventSource",
            "open",
            "eval",
            "Function",
            "process",
          ].map((property) => ({ object, property, message: "Demo code can't do this." })),
        ),
        {
          object: "navigator",
          property: "sendBeacon",
          message: "Demo code can't make network calls.",
        },
        ...["innerHTML", "outerHTML", "insertAdjacentHTML"].map((property) => ({
          property,
          message: "Demo code can't inject HTML.",
        })),
        { property: "constructor", message: "Demo code can't reach constructors to build code." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExpressionStatement[directive='use server']",
          message: "Demo code can't define server actions.",
        },
        {
          selector:
            "JSXAttribute[name.name='dangerouslySetInnerHTML'], Property[key.name='dangerouslySetInnerHTML'], Property[key.value='dangerouslySetInnerHTML']",
          message: "Demo code can't inject HTML.",
        },
        {
          selector:
            "CallExpression[callee.object.name='document'][callee.property.name=/^writeln?$/]",
          message: "Demo code can't inject HTML.",
        },
        {
          selector: "NewExpression[callee.name='Function']",
          message: "Demo code can't evaluate strings as code.",
        },
        { selector: "ImportExpression", message: "Demo code can't load modules dynamically." },
        {
          selector:
            "CallExpression:matches([callee.name='createElement'], [callee.property.name='createElement'])[arguments.0.value=/^(script|iframe|object|embed|link|base)$/i]",
          message: "Demo code can't embed scripts or external content.",
        },
        {
          selector: "JSXOpeningElement[name.name=/^(script|iframe|object|embed|base)$/]",
          message: "Demo code can't embed scripts or external content.",
        },
      ],
    },
  },
  // The loader is written by the workflow from a fixed template (CI compares it
  // byte for byte) and is the one place a demo is imported dynamically, so it
  // runs in the browser only.
  {
    files: ["src/app/demos/*/demo-loader.tsx"],
    rules: { "no-restricted-syntax": "off" },
  },
  // Disable stylistic rules that conflict with Prettier. Keep this last.
  prettier,
  globalIgnores([".next/**", "out/**", "build/**", "coverage/**", "next-env.d.ts"]),
]);

export default eslintConfig;
