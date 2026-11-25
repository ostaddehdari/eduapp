# S02-W06 acceptance

Install locked workspace packages and the pinned Playwright headless Chromium. Build each frontend and run the date and browser tests.

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm exec playwright install --with-deps --only-shell chromium
corepack pnpm --filter @eduapp/public-web build
corepack pnpm --filter @eduapp/control-panel build
node --test tests/S02-W06/*.test.mjs
```

The browser tests serve both builds on local ports, without a backend connection. They exercise Persian RTL, a bundled typeface, shared CSS tokens, keyboard focus and disclosures, reduced motion, mobile layout, two distinct preview records, UTC markup and date rollover. Unknown and duplicate selections show a generic message. All fixture data is synthetic.

Run `corepack pnpm --filter @eduapp/public-web dev` or `corepack pnpm --filter @eduapp/control-panel dev` to review the interactive versions locally.
