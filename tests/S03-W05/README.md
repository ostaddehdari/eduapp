# S03-W05 acceptance

Run the fixed-schema and owner routing tests.

```sh
node --test tests/S03-W05/security-audit.test.mjs
```

Run native PostgreSQL acceptance against a disposable PostgreSQL 17 service on loopback with the test database `eduapp_s03_audit_test`. Provide its administrator URL through `EDUAPP_S03_AUDIT_PG_ADMIN_URL`.

```sh
node --test tests/S03-W05/postgres-security-audit.test.mjs
```

The fixture exercises two tenant scopes using restricted roles, including the absence of cross-tenant reads, stale membership rejection, denial without a user-supplied resource ID, and append-only writes. It verifies that an authorization failure in the audit append rolls back the owner transaction and that prior Platform audit events still write normally. The IAM login tests validate restricted append-only storage with scoped correlation for verified success and no tenant or session for a denial. Use synthetic seed data. Run suites that share owner login names sequentially against the same cluster because native setup resets fixture role passwords.
