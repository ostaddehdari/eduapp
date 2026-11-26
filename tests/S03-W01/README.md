# Authentication acceptance · S03-W01-T03

Run `node --test tests/S03-W01/*.test.mjs` with `EDUAPP_AUTH_PG_ADMIN_URL` pointing to a disposable loopback PostgreSQL 17 fixture named `eduapp_s03_auth_test`. The administrator can create the test database if needed. The suite rotates synthetic test login credentials and uses random fixtures. It verifies the Gateway over HTTP and the IAM and Access boundaries using separate PostgreSQL roles. OTP delivery is captured by an in-process fake.
