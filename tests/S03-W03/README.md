# S03-W03 acceptance

Run the local Gateway fixture with Node.js.

```sh
node --test tests/S03-W03/access.test.mjs
```

This sends real loopback requests with two synthetic tenant scopes, validates custom roles and preconditions, and exercises masked School and People responses. The School and Billing fixtures drive relationship revocation and entitlement loss without either service's database.

Run the database acceptance only against a disposable PostgreSQL 17 fixture with the database `eduapp_s03_access_test`. Provide a loopback administrator URL through `EDUAPP_S03_ACCESS_PG_ADMIN_URL`. The test checks migration replay, role scoping, policy updates, a reused owner connection, and expired role assignments.

```sh
node --test tests/S03-W03/postgres-access.test.mjs
```

The disposable fixture resets owner-login passwords during setup. Run this test serially with other suites that share its PostgreSQL cluster.
