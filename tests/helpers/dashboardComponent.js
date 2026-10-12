import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";

const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/compiled/babel/core");

// Exercise component handlers and hook state without installing a DOM runtime.
// This deliberately does not simulate layout, browser events, or React scheduling.
export function dashboardComponent(path, imports = {}) {
  const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const { code } = transformSync(source, {
    filename: path,
    babelrc: false,
    configFile: false,
    presets: [
      [require("next/dist/compiled/babel/preset-react"), { runtime: "classic" }],
      [require("next/dist/compiled/babel/preset-env"), { targets: { node: "current" }, modules: "commonjs" }],
    ],
  });
  const state = [];
  const dependencies = [];
  let cursor = 0;
  let effects = [];
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], (value) => {
        state[index] = typeof value === "function" ? value(state[index]) : value;
      }];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!dependencies[index] || deps.some((value, i) => value !== dependencies[index][i])) {
        dependencies[index] = deps;
        effects.push(effect);
      }
    },
  };
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", "React", code)(
    (id) => id === "react" ? { ...React, ...hooks } : imports[id] || {
      __esModule: true, default: id.split("/").pop(),
    },
    compiledModule, compiledModule.exports, React,
  );
  return {
    render(props) {
      cursor = 0;
      const tree = compiledModule.exports.default(props);
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
      return tree;
    },
  };
}

export function elements(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, predicate));
  return [
    ...(predicate(tree) ? [tree] : []),
    ...elements(tree.props?.children, predicate),
  ];
}

export function textContent(tree) {
  if (tree == null || typeof tree === "boolean") return "";
  if (Array.isArray(tree)) return tree.map(textContent).join("");
  if (typeof tree !== "object") return String(tree);
  return textContent(tree.props?.children);
}
