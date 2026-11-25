# EduApp PostgreSQL data boundary

This package implements [DATA-001](../../docs/contracts/S02-W03.md) using PostgreSQL 17. Provision a dedicated EduApp database and review the migration in a disposable environment before scheduling any production change.

## Database initialization

1. Have a provisioning administrator run `node packages/data/src/migrate.mjs bootstrap` with the administrator connection provided as `EDUAPP_DATABASE_URL`. Bootstrap grants named application logins access to the dedicated database and revokes ambient database and `public` schema access. Provision runtime and migration authentication separately using the deployment secret store.
2. Run `node packages/data/src/migrate.mjs apply` with the `eduapp_schema_migrator` connection provided as `EDUAPP_DATABASE_URL`. The migration acquires a database-local lock and commits the schema and its checksum receipt together. Repeating the command checks the receipt and exits successfully if the applied SQL matches it.
3. Build each owner-service pool with its own login, for example `eduapp_tenancy_api`. Use the transaction runner after resolving and authorizing the tenant in that owner service.

The SQL includes a schema-owner role per owned schema and narrower logins for each owner and the runtimes authorized in the operating model. Billing catalog reads go through Billing. Catalog writes require separate controlled provisioning. Append-only tables omit the ordinary update and delete grants. The Platform outbox append function grants producers a scoped append operation and checks the logged-in role against the event type.

```js
import { createTenantTransactions } from '@eduapp/data/tenant-transactions';

const tenantTransactions = createTenantTransactions(ownerPool);
const { rows } = await tenantTransactions.run(verifiedTenantId, (db) =>
  db.query('SELECT id, code FROM tenancy_organization.org_units WHERE code = $1', [unitCode]),
);
```

Provide a node-postgres-compatible pool. The callback receives query access to the checked-out transaction and is trusted owner-service code. Await each statement before leaving the callback. The verified tenant must come from the authorization step, such as an active membership and school scope. Owner-private global operations keep their distinct authorization paths.

Restore an already migrated environment only through its approved recovery plan and a tested backup or a reviewed forward migration. A failed database transaction leaves its migration receipt unapplied.
