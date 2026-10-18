---
name: faithful-demo
description: Build an interactive demo of a change to an existing app that looks exactly like that app, by capturing its real rendered pages and compiling its own styles. Use for mockups, previews, or prototypes of new UI in an existing product, and for implementing an approved demo.
---

# Faithful demo

The demo has to pass as a screenshot of the real app. The user should only notice the new feature, never the frame around it. The real app is the design system. Capture it and reuse its DOM, stylesheet, components, fonts, icons, and copy. A palette or sidebar you write yourself makes the demo look like some other product.

Work in `mockups/<feature>/` in the app's repo unless the user names a place. If the folder already has a `DEMO.md`, read it and continue from its decisions.

## 1. Look at the real app

Run the app locally and open the page the feature belongs on. Screenshot it in light and dark mode at desktop width. These screenshots are the reference everything gets compared against.

- Give the dev server throwaway state: a fresh temp data dir, a seeded or test password, a test database. The user's real DB and credentials stay out of it. Check the repo's docs, `package.json` scripts, and `.env.example` for the variables and any existing seed script. For 10router, seed a temp dir with `scripts/seed-demo.mjs` the way `npm run dev:demo` does, then start the dev server on it:

  ```sh
  export DATA_DIR=$(mktemp -d)
  node --experimental-loader=./scripts/resolve-src-alias.mjs scripts/seed-demo.mjs
  INITIAL_PASSWORD=demo-password npx next dev -p 20199
  ```

  Login is `POST /api/auth/login` with `{"password": "demo-password"}`.
- Seed enough fake data that the page looks lived-in. An empty state is a different screen.
- If the app can't run (missing services, no credentials, too heavy), read [references/stacks.md](references/stacks.md) "Apps you can't run" before going further.

Done when you hold real screenshots of the target page and have read the source of the route and every component on it.

## 2. Capture the shell

```sh
node <skill-dir>/scripts/capture.mjs <page-url> mockups/<feature>/captured \
  --name <page> [--login login.mjs] [--dark-class dark]
```

This saves the rendered DOM with scripts stripped, every loaded stylesheet with `url()`s rewritten, the fonts and images, and light/dark screenshots. `--login` takes a module exporting `async (page, origin) => {}` that signs in. Keep that module outside the repo when it holds a password, or read the password from an env var. If Playwright is missing, the script prints the one-time install command. Tell the user before you run it.

Capture every page and overlay the demo touches: the list page, an existing modal opened by clicking, the detail page. Open the existing modal for real and capture it, because a dialog built from the real Modal markup beats any guess.

Done when `captured/<page>.html` plus `captured/<page>.css` open from disk, with the dev server stopped, and look identical to the step 1 screenshot. Compare them side by side.

## 3. Compile the app's own styles

The captured CSS only contains classes the page already used, so new UI needs the stylesheet built by the app's own toolchain with the demo source included. How depends on the stack, read the matching section of [references/stacks.md](references/stacks.md): Tailwind, CSS modules, plain CSS/Sass, or a component library.

Keep a demo-only CSS file for animations or helpers the app lacks, and keep it a few lines long. If you're writing colors, font families, or radii into it, stop and find the app's token.

## 4. Build the new piece inside the real page

- Write a build script (`scripts/build.mjs`) that takes `captured/<page>.html`, finds the content slot (the element that holds the page body, inside the real sidebar and header), and swaps in the demo mount point. Keep the real neighbors: when the feature adds one card to a grid, the other cards stay captured cards.
- Strip `<script>` tags from the captured DOM **before** injecting the demo's own script tag. Stripping afterwards deletes the demo.
- Build new UI from the app's real components. Either import them through a preview entry (React/Vue/Svelte, see stacks.md) or copy their exact class strings or markup from source into small helpers (`btn()`, `input()`, `badge()`). Name the source file next to each copy.
- Copy only the icons and images the demo uses from the app's `public/` or asset folder. Reuse the app's icon font or icon set.
- Write copy in the app's voice and terminology. Pull real product nouns from its UI strings.

## 5. Simulate the outside world

Put every fake upstream, API, or slow operation in one `SCENARIOS` map at the top of the demo script, and add a small on-page switcher so the user can flip between them. Cover at least the happy path, a quirky case the feature is meant to handle, and a failure, each with believable latency. Fake data uses the real response shapes and names that look like the user's own data.

Mark the switcher as demo-only so nobody mistakes it for a proposed control.

## 6. Click through it

Serve `dist/` and drive it in a real browser (Playwright, the host's browser tools). Walk every scenario end to end, in light and dark, then at a phone width. Watch the console and failed requests. Compare each screen against the step 1 screenshots: font, spacing, radii, colors, icon weight. Fix differences by finding what the real app does, never by eyeballing a new value.

Done when every scenario is clicked through in both themes with a clean console, and you'd confuse a screenshot of the demo shell with the real one.

## 7. Record and publish

Copy [assets/DEMO.md](assets/DEMO.md) into the demo folder and fill it in: how it's built, what's simulated, the decisions so far, and what was checked (including what wasn't). Update it after every round of feedback.

Publish `dist/` with the `cf-drop` skill, if your agent has it, unless the user asked for local-only or named another host. Deploy `dist/` only, never `captured/` source or the repo.

A demo built on throwaway data publishes without asking. Before publishing, look through `dist/` for anything real: names, emails, keys, account IDs, usage numbers from someone's actual install. If you find any, or can't tell where the data came from, ask the user before publishing.

## Clean up

- `next dev` and similar tools rewrite tracked files (Next re-adds a block to `AGENTS.md` and can rewrite version ranges in `package.json`). Run `git status` and revert anything you didn't mean to change.
- Leave no stray lockfiles (`bun.lock`, `package-lock.json`) in the repo or demo folder that weren't there before.
- Stop the dev servers and delete the temp data dirs.
- Add `dist/` and `node_modules/` to the demo's `.gitignore`.

## Implementing an approved demo

When the user approves and asks for the real thing, build it in the app's actual route, treating the latest demo as the spec. Replace each `SCENARIOS` entry with the real call, keep the layout and copy that was accepted, and say where you had to deviate and why. Test the real route in the browser across the same states, then run the repo's own checks.
