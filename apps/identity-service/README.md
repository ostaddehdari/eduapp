# EduApp identity context

The Gateway runtime can register existing authentication and people operations through its `identity` option. The factory callers provide three separate PostgreSQL pools using the IAM, People and Access runtime roles. The three role identities match `packages/data/migrations/bootstrap.sql`.

Provide distinct keys for access signing and OTP digest protection through a protected configuration source. Provide a delivery adapter for the enabled notification paths. Supply the People and Access policy callback from the application owner. It must grant only the specific operation and target scope already verified for the actor. The runtime requires an explicit authorization callback and the service checks active membership independently of that policy.

For a disposable database, bootstrap with the provisioning principal, then run the data package's `apply-identity` command with the migration principal. The foundation-only `apply` command remains available for S02 verification.

```sh
node packages/data/src/migrate.mjs bootstrap
node packages/data/src/migrate.mjs apply-identity
```

Each command reads `EDUAPP_DATABASE_URL` from the service configuration. Grant no migration credentials to the running Gateway. OTP and invitation tests use synthetic destinations and injected delivery fixtures. Provider wiring and operational release are handled under their own deployment tasks.

[Authentication and sessions](../../docs/contracts/S03-W01.md) · [People and memberships](../../docs/contracts/S03-W02.md)
