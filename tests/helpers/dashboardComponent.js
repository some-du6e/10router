import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";

const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/compiled/babel/core");

// Exercise component handlers and hook state without installing a DOM runtime.
// This deliberately does not simulate layout, browser events, or React scheduling.
export function dashboardComponent(path, imports = {}, componentName = null) {
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
  // One cell per hook call, in call order, as React keeps them.
  const cells = [];
  const effectCells = [];
  let cursor = 0;
  let pending = [];
  const cell = (create) => {
    const index = cursor++;
    const isNew = !(index in cells);
    if (isNew) cells[index] = create();
    return [cells[index], isNew];
  };
  // No deps array means "changed on every render", as in React.
  const depsChanged = (previous, next) => !previous || !next || previous.length !== next.length
    || next.some((value, i) => !Object.is(value, previous[i]));
  const runCleanup = (slot) => {
    if (typeof slot.cleanup === "function") slot.cleanup();
    slot.cleanup = undefined;
  };
  const hooks = {
    useCallback(callback, deps) {
      const [slot, isNew] = cell(() => ({ value: callback, deps }));
      if (!isNew && depsChanged(slot.deps, deps)) Object.assign(slot, { value: callback, deps });
      return slot.value;
    },
    useRef(initial) {
      return cell(() => ({ current: initial }))[0];
    },
    useState(initial) {
      const [slot] = cell(() => {
        const created = { value: typeof initial === "function" ? initial() : initial };
        created.set = (value) => { created.value = typeof value === "function" ? value(created.value) : value; };
        return created;
      });
      return [slot.value, slot.set];
    },
    useEffect(effect, deps) {
      const [slot, isNew] = cell(() => ({ deps, cleanup: undefined }));
      if (isNew) effectCells.push(slot);
      else if (!depsChanged(slot.deps, deps)) return;
      slot.deps = deps;
      pending.push({ slot, effect });
    },
  };
  const compiledModule = { exports: {} };
  const componentCode = componentName ? `${code}\nmodule.exports.default = ${componentName};` : code;
  new Function("require", "module", "exports", "React", componentCode)(
    (id) => id === "react" ? { ...React, ...hooks } : imports[id] || {
      __esModule: true, default: id.split("/").pop(),
    },
    compiledModule, compiledModule.exports, React,
  );
  return {
    render(props) {
      cursor = 0;
      const tree = compiledModule.exports.default(props);
      const queued = pending;
      pending = [];
      // Like React: every changed effect's cleanup runs before any effect re-runs.
      queued.forEach(({ slot }) => runCleanup(slot));
      queued.forEach(({ slot, effect }) => { slot.cleanup = effect(); });
      return tree;
    },
    unmount() {
      effectCells.forEach(runCleanup);
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
