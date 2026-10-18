---
name: faithful-demo
description: Build an interactive demo of a change to an existing app that looks exactly like that app, by capturing its real rendered pages and compiling its own styles. Use for any mockup, preview, or prototype of UI that belongs in an existing app, before building a page from scratch, and for implementing an approved demo.
---

# Faithful demo

The demo has to pass as a screenshot of the real app. The user should only notice the new feature, never the frame around it. The real app is the design system. Capture it and reuse its DOM, stylesheet, components, fonts, icons, and copy. A palette or sidebar you write yourself makes the demo look like some other product.

Work in `mockups/<feature>/` in the app's repo unless the user names a place. Make sure the repo's `.gitignore` covers `mockups/`. Tailwind and similar tools scan every file that isn't ignored, so an unignored demo leaks its classes into the app's real CSS. If the folder already has a `DEMO.md`, read it and continue from its decisions.

## 1. Look at the real app

Run the app locally and open the page the feature belongs on. Screenshot it in light and dark mode at desktop width, and at phone width too if the feature touches layout. These screenshots are the reference everything gets compared against.

- Give the dev server throwaway state: a fresh temp data dir, a seeded or test password, a test database. The user's real DB and credentials stay out of it. Check the repo's docs, `package.json` scripts, and `.env.example` for the variables and any existing seed script. For 10router, seed a temp dir with `scripts/seed-demo.mjs` the way `npm run dev:demo` does, then start the dev server on it. Agent shells often lose environment variables between calls, so make the dir once and put its literal path on every command:

  ```sh
  mktemp -d    # prints e.g. /tmp/tmp.AbC123
  DATA_DIR=/tmp/tmp.AbC123 node --experimental-loader=./scripts/resolve-src-alias.mjs scripts/seed-demo.mjs
  DATA_DIR=/tmp/tmp.AbC123 NEXT_DIST_DIR=.next-demo INITIAL_PASSWORD=demo-password npx next dev --webpack -p 20199
  ```

  The seed wipes the database `DATA_DIR` points at, and refuses to run without it. A `DATA_DIR` on the command line beats the one in `.env`; leave it off `next dev` and the server opens the real install. `NEXT_DIST_DIR` keeps this server from fighting a `npm run dev` the user already has running. Log in with a `--login` module (step 2) whose default export is:

  ```js
  export default async (page, origin) => {
    const r = await page.request.post(`${origin}/api/auth/login`, { data: { password: "demo-password" } });
    if (!r.ok()) throw new Error(`login ${r.status()}`);
  };
  ```
- Before capturing anything, confirm the server is running on the throwaway data: the page shows only your seeded records.
- Seed enough fake data that the page looks lived-in. An empty state is a different screen.
- If the app can't run (missing services, no credentials, too heavy), read [references/stacks.md](references/stacks.md) "Apps you can't run" before going further.

Done when you hold real screenshots of the target page and have read the source of the route and every component on it.

## 2. Capture the shell

```sh
node <skill-dir>/scripts/capture.mjs <page-url> mockups/<feature>/captured \
  --name <page> [--login login.mjs] [--setup setup.mjs] [--dark-class dark] [--width 390]
```

This saves the rendered DOM with scripts stripped and linked to `<page>.css`, every stylesheet the page loaded, the fonts and images, and light/dark screenshots of the live page. It exits non-zero on a 404, a failed login, or a redirect away from the page. `--login` and `--setup` each take a module whose default export is an async function. `--login` gets `(page, origin)` and runs before the page loads. `--setup` gets `(page)` and runs after, so it can click. If Playwright is missing, the script prints the one-time install command. Tell the user before you run it.

Capture every page and overlay the demo touches, each under its own `--name`: the list page, the detail page, and any existing modal. For a modal, pass a `--setup` that clicks the real trigger and waits for the dialog, because a dialog built from the real Modal markup beats any guess. Capture at `--width 390` too if the feature touches layout.

Look through the capture for real data now, before any of it reaches a screenshot or `dist/`: names, emails, keys, account IDs, usage numbers from someone's actual install. If you find any, go back to step 1.

Done when, with the dev server stopped, you've opened `captured/<page>.html` over `file://` in a browser, screenshotted it, and it matches `<page>-light.png` with fonts and icons loaded and no failed requests. The PNGs the script wrote come from the live server, so they prove nothing about the copy on disk.

## 3. Compile the app's own styles

The captured CSS only contains classes the page already used, so new UI needs the stylesheet built by the app's own toolchain with the demo source included. How depends on the stack, read the matching section of [references/stacks.md](references/stacks.md): Tailwind, CSS modules, plain CSS/Sass, or a component library.

Keep a demo-only CSS file for animations or helpers the app lacks, and keep it a few lines long. If you're writing colors, font families, or radii into it, stop and find the app's token.

Done when the compiled stylesheet contains a class that only the demo's `src/` uses (grep for it), and the demo CSS has no color, font-family, or radius literals.

## 4. Build the new piece inside the real page

- Write a build script (`scripts/build.mjs`) that takes `captured/<page>.html`, finds the content slot (the element that holds the page body, inside the real sidebar and header), and swaps in the demo mount point. Keep the real neighbors: when the feature adds one card to a grid, the other cards stay captured cards.
- Build one `dist/` page per captured page. Point links between captured pages at each other and every other link at `#`, since the rest of the app isn't there.
- If you strip `<script>` tags yourself (a preview-entry build, a hand capture), do it **before** injecting the demo's own script tag. Stripping afterwards deletes the demo.
- Build new UI from the app's real components. Either import them through a preview entry (React/Vue/Svelte, see stacks.md) or copy their exact class strings or markup from source into small helpers (`btn()`, `input()`, `badge()`). Name the source file next to each copy.
- Copy only the icons and images the demo uses from the app's `public/` or asset folder. Reuse the app's icon font or icon set.
- Write copy in the app's voice and terminology. Pull real product nouns from its UI strings.

Done when every element the demo adds traces to a named source component or captured markup, and the content slot is the only part of the captured shell you changed.

## 5. Simulate the outside world

Put every fake upstream, API, or slow operation in one `SCENARIOS` map at the top of the demo script, and add a small on-page switcher so the user can flip between them. Cover at least the happy path, a quirky case the feature is meant to handle, and a failure, each with believable latency. Fake data uses the real response shapes and names that look like the user's own data.

Mark the switcher as demo-only so nobody mistakes it for a proposed control.

Done when the switcher flips between at least three scenarios without a reload.

## 6. Click through it

Serve `dist/` and drive it in a real browser (Playwright, the host's browser tools). Walk every scenario end to end, in light and dark, then at a phone width (compare against the phone screenshots if you took them). Watch the console and failed requests. Compare each screen against the step 1 screenshots: font, spacing, radii, colors, icon weight. Fix differences by finding what the real app does, never by eyeballing a new value.

Done when every scenario is clicked through in both themes with a clean console, and you'd confuse a screenshot of the demo shell with the real one.

## 7. Record and publish

Copy [assets/DEMO.md](assets/DEMO.md) into the demo folder and fill it in: how it's built, what's simulated, the decisions so far, and what was checked (including what wasn't). Update it after every round of feedback.

Publish `dist/` with the `cf-drop` skill, if your agent has it, unless the user asked for local-only or named another host. Deploy `dist/` only, never `captured/` source or the repo.

A demo built on throwaway data publishes without asking. Before publishing, look through `dist/` for anything real, using the same list as step 2, plus internal URLs baked into the page. If you find any, or can't tell where the data came from, ask the user before publishing.

## Clean up

- `next dev` and similar tools rewrite tracked files (Next re-adds a block to `AGENTS.md` and can rewrite version ranges in `package.json`). Run `git status` and revert anything you didn't mean to change.
- Leave no stray lockfiles (`bun.lock`, `package-lock.json`) in the repo or demo folder that weren't there before.
- Stop the dev servers and delete the temp data dirs and the `.next-demo` build dir.

## Implementing an approved demo

When the user approves and asks for the real thing, build it in the app's actual route, treating the latest demo as the spec. Replace each `SCENARIOS` entry with the real call, keep the layout and copy that was accepted, and say where you had to deviate and why. Test the real route in the browser across the same states, then run the repo's own checks.
