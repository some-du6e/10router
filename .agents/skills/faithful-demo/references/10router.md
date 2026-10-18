# Running 10router for a demo

Seed a temp dir with `scripts/seed-demo.mjs` the way `npm run dev:demo` does, then start the dev server on it. Agent shells often lose environment variables between calls, so make the dir once and put its literal path on every command:

```sh
mktemp -d    # prints e.g. /tmp/tmp.AbC123
DATA_DIR=/tmp/tmp.AbC123 node --experimental-loader=./scripts/resolve-src-alias.mjs scripts/seed-demo.mjs
DATA_DIR=/tmp/tmp.AbC123 NEXT_DIST_DIR=.next-demo INITIAL_PASSWORD=demo-password npx next dev --webpack -p 20199
```

The seed wipes the database `DATA_DIR` points at. It refuses to run when `DATA_DIR` is unset, or when 10router falls back to the real install because the path isn't writable or is a Unix path on Windows. On Windows, make the dir with a Windows path. A `DATA_DIR` on the command line beats the one in `.env`. Leave it off `next dev` and the server opens the real install. `NEXT_DIST_DIR` keeps this server from fighting a `npm run dev` the user already has running. Pass `capture.mjs` a `--login` module whose default export is:

```js
export default async (page, origin) => {
  const r = await page.request.post(`${origin}/api/auth/login`, { data: { password: "demo-password" } });
  if (!r.ok()) throw new Error(`login ${r.status()}`);
};
```

The seed fills providers, a custom endpoint, one API key, and a proxy pool. Usage, combos, and notifications start empty, so seed more before demoing those pages. Clean up the `.next-demo` dir afterwards.
