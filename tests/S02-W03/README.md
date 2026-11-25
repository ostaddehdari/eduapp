# PostgreSQL acceptance · S02-W03-T03

Run the suite against a disposable PostgreSQL 17 server with the local test database `eduapp_w03_test`. Set `EDUAPP_PG_ADMIN_URL` using the disposable administrator credentials, then run `node --test tests/S02-W03/postgres-isolation.test.mjs` from the checkout root. The suite initializes that database on the first run and assigns random fixture credentials to its test roles. It can be run again against the same disposable database with new fixture row IDs.

The suite reads the versioned data contract, checks the migrated catalog and exercises real owner logins with two generated school tenants. Cases cover row policy visibility and writes, role and owner privileges, composite tenant references, physical connection reuse across commit and rollback, failed cleanup, tenant-scoped and global keys, and transactional outbox and inbox behavior.
