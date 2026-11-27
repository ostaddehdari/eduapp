# S04-W03 acceptance

Install the workspace from its lockfile. Run the React application checks and the browser acceptance.

```sh
corepack pnpm --filter @eduapp/control-panel typecheck
corepack pnpm --filter @eduapp/control-panel test
node --test tests/S04-W03/browser.test.mjs
```

Browser acceptance uses Playwright Chromium. Set `EDUAPP_CHROMIUM_EXECUTABLE` to a compatible system Chromium binary, or install the Playwright Chromium version from the locked workspace tool. The browser suite builds the control panel with a relative asset base and serves it under `/eduapp/panel/` on loopback.

- Demo mode verifies RTL and mobile fit, focus on the next step, local resume after refresh, isolated progress for the Aftab and Baran samples, reset, and the lack of API requests.
- Gateway mode uses a same-origin HTTP fixture to verify actual browser request/response contracts, focused progression, two independent tenants, no credential persistence, second-factor rejection and retry, and a clearly labeled site draft.
- The native Gateway suite independently exercises authenticated onboarding transactions with the database configured through its disposable PostgreSQL fixture.

The browser suite uses synthetic identities and checks the exercise summary before any public production preview is published.
