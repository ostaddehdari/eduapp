# MFA acceptance · S03-W04-T03

Run `node --test tests/S03-W04/*.test.mjs` from the checkout root with `EDUAPP_MFA_PG_ADMIN_URL` pointing to disposable loopback PostgreSQL 17 and database `eduapp_s03_mfa_test`. The suite uses throwaway identities, an independent Access role and authenticator codes generated for synthetic fixture secrets.

The test exercises real HTTP on the Gateway, migration and database-backed proofs across two scopes. It checks sensitive action gating, factor enrollment, replays, expiry, restricted recovery, session revocation and append-only audit.
