# Styles and components per stack

Read the section for the app's stack. In every case the goal is the same: the browser receives the app's real stylesheet, compiled by the app's real toolchain, and the demo's markup comes from the app's real components.

Resolve build tools from the app's own `node_modules` (`createRequire(path.join(repoRoot, "package.json"))`) so the demo builds with the exact versions the app ships. Record anything installed elsewhere in `DEMO.md`.

## Tailwind

Compile the app's entry stylesheet (`globals.css`, `app.css`, `index.css`) with its PostCSS config and add the demo source to the scan.

- Tailwind v4: append `@source "<abs path to mockups/<feature>/src>";` to the stylesheet text before handing it to `@tailwindcss/postcss` with `base: repoRoot`.
- Tailwind v3: pass a config that spreads the app's `tailwind.config.*` and adds the demo glob to `content`.

Fonts loaded by a framework font helper (`next/font`, `@fontsource` via JS) don't appear in the source stylesheet. Lift their `@font-face` rules and the variable class (`.__variable_xxxx { --font-inter: ... }`) out of the captured CSS and prepend them.

Dark mode is usually a `.dark` class on `<html>`. Wire the captured theme toggle to flip it the way the app's ThemeProvider does.

Worked example: [examples/tailwind-next-build.mjs](examples/tailwind-next-build.mjs), from the 10router add-endpoint demo. It compiles `src/app/globals.css` this way, lifts the Inter faces from the capture, swaps the `max-w-7xl` content slot, and extracts the real provider grid. Copy its approach. Its selectors and font class names are specific to that page.

## CSS modules

Module class names are hashed per build, so copying class strings from source doesn't work. Two options:

- Import the real components through a preview entry (below) and let the bundler compile their modules with the app's config. Preferred.
- For a static demo, copy the hashed class names out of the captured DOM. They're stable only for that build, so the demo has to ship the captured CSS rather than recompile it. New UI has to reuse existing hashed classes, and any genuinely new style goes in the demo CSS using the app's custom properties.

## Plain CSS, Sass, Less

Build the app's stylesheet with its own command or compiler (`sass src/styles/main.scss`), or take the compiled file from a production build. Write new markup with the app's existing class names, which you find by reading the components that render similar UI. Custom properties (`--color-*`, `--radius-*`) are the tokens; read them from `:root` in the compiled CSS.

## Component libraries (MUI, Chakra, Mantine, Ant, shadcn, Radix)

CSS-in-JS styles only exist at runtime, so the captured CSS is a snapshot. Build the demo as a small app instead:

- A preview entry renders the app's real theme provider, layout, and the new feature component, bundled with esbuild or Vite from the app's dependencies.
- Use the app's theme object, never the library's default theme. The default theme is exactly how demos end up looking generic.
- shadcn components are files in the repo (`components/ui/*`). Import those, not the upstream package.

## Preview entries (React, Vue, Svelte)

Use an existing Storybook, Ladle, or demo route when one already renders the right components. Otherwise write a small entry that imports the real layout and components.

- Alias framework-only modules to small local stubs: for Next, `next/link` becomes a plain `<a>` and `next/navigation` returns a fixed pathname and a no-op router. Stub only what the imported components actually call.
- Mock the API responses the shell itself fetches (session, settings, counts) with the real response shapes. Returning `{}` everywhere hides broken screens.
- If a component pulls in server-only code (DB, filesystem, credential stores), trace the import and cut the dependency at the boundary. Don't stub arbitrary modules until the build goes quiet.
- Keep aliases and fetch mocks in the demo's build config. The app's production entry stays untouched.

## Apps you can't run

When the app needs services or credentials you don't have:

1. Ask the user for screenshots of the target page in light and dark, or look for existing ones (README, docs, design files, issue attachments, a deployed staging URL you can open read-only).
2. Read the real source for the layout, page, and every component the demo touches. Build the shell by rendering those components through a preview entry with mocked data, which usually runs even when the full app doesn't.
3. If even that fails, build static markup by hand from the components' source: same element structure, same class names, same icon names, the app's compiled stylesheet. Then put your render next to the user's screenshot and fix every difference.
4. Write in `DEMO.md` that the shell was reconstructed, not captured, and what you compared it against.

## Assets

Copy fonts, icon fonts, and images the demo actually references into `dist/` with relative paths, so the site works from any URL prefix. Use the app's own logo and icons. Exclude source maps, `.env` files, browser profiles, and anything from the throwaway data dir.
