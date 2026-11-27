# EduApp identity context

The Gateway runtime can register existing authentication and people operations through its `identity` option. The factory callers provide three separate PostgreSQL pools using the IAM, People and Access runtime roles. The three role identities match `packages/data/migrations/bootstrap.sql`.

Provide distinct keys for access signing and OTP digest protection through a protected configuration source. Provide a delivery adapter for the enabled notification paths. Supply the People and Access policy callback from the application owner. It must grant only the specific operation and target scope already verified for the actor. The runtime requires an explicit authorization callback and the service checks active membership independently of that policy.

The composed Access policy is available through `accessPolicy`. Pass the School owner's verified relationship and Billing owner's entitlement ports for rules that require them. Role management, invitations and direct membership changes require a fresh MFA proof bound to the current authenticated membership and session revision. Set `mfaEncryptionKey` from a separate protected key to enable IAM factor enrollment, step-up and recovery in the Gateway. Supply either the composed policy or an owner authorization callback.

For a disposable database, bootstrap with the provisioning principal, then run the data package's `apply-identity` command with the migration principal. The foundation-only `apply` command remains available for S02 verification.

```sh
node packages/data/src/migrate.mjs bootstrap
node packages/data/src/migrate.mjs apply-identity
```

Each command reads `EDUAPP_DATABASE_URL` from the service configuration. Grant no migration credentials to the running Gateway. OTP and invitation tests use synthetic destinations and injected delivery fixtures. Provider wiring and operational release are handled under their own deployment tasks.

The composed Gateway records login outcomes, role changes, delegation and sensitive reads through the restricted audit paths installed by `apply-identity`. Login outcomes stay in an IAM-private table. Tenant audit records carry verified scope and a server request ID.

[Authentication and sessions](../../docs/contracts/S03-W01.md) · [People and memberships](../../docs/contracts/S03-W02.md) · [Access policy](../../docs/contracts/S03-W03.md) · [MFA and recovery](../../docs/contracts/S03-W04.md) · [Security audit](../../docs/contracts/S03-W05.md)
