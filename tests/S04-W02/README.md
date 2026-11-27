# S04-W02 acceptance

Run input and owner-scope validation locally.

```sh
node --test tests/S04-W02/organization-tree.test.mjs
```

For native acceptance, provision a disposable local PostgreSQL 17 fixture with the database `eduapp_s04_org_test` and pass its admin connection URL in `EDUAPP_S04_ORG_PG_ADMIN_URL`.

```sh
node --test tests/S04-W02/postgres-organization-tree.test.mjs
```

The migration runner applies the foundation and organization migration as the restricted migrator. The test checks all supported organization forms, standalone schools and schools under a collection or branch, legacy rows, isolated tenant listing, cursor pagination, sibling uniqueness, repeat creation, cross-tenant parent isolation, optimistic versions and two concurrent conflicting moves. It also checks suspension and deliberately causes a fixture outbox write failure to show the unit and its creation receipt roll back together. Use synthetic seed data and run suites resetting the same native role passwords sequentially on a shared cluster.
