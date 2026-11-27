import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { applySecurityAudit, applyTenantIsolation, runSqlBootstrap } from '../../packages/data/src/migrate.mjs';
import { createTenantTransactions } from '../../packages/data/src/tenant-transactions.mjs';
import {
  appendIamSecurityEvent, appendTenantSecurityEvent, createSecurityAudit,
} from '../../apps/audit-service/src/service.mjs';

const config = process.env.EDUAPP_S03_AUDIT_PG_ADMIN_URL;

test('PostgreSQL scopes append-only audit rows and rolls back the owner effect when audit fails', {
  timeout: 30_000,
}, async t => {
  assert(config, 'Set EDUAPP_S03_AUDIT_PG_ADMIN_URL for disposable PostgreSQL 17');
  const url = new URL(config);
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/eduapp_s03_audit_test');
  assert.equal(url.search + url.hash, '');
  const provisioningUrl = new URL('/postgres', url);
  const provisioning = new pg.Client({ connectionString: provisioningUrl.href, connectionTimeoutMillis: 3000 });
  await provisioning.connect();
  try {
    const exists = await provisioning.query("SELECT 1 FROM pg_database WHERE datname = 'eduapp_s03_audit_test'");
    if (!exists.rowCount) await provisioning.query('CREATE DATABASE eduapp_s03_audit_test');
  } finally {
    await provisioning.end();
  }
  const admin = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  await admin.connect();
  t.after(() => admin.end());
  assert.match((await admin.query('SHOW server_version_num')).rows[0].server_version_num, /^17\d{4}$/);
  await runSqlBootstrap(admin);

  async function roleUrl(role) {
    const password = randomBytes(24).toString('hex');
    await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
    const credentials = new URL(url);
    credentials.username = role;
    credentials.password = password;
    return credentials.href;
  }
  const migrator = new pg.Client({ connectionString: await roleUrl('eduapp_schema_migrator') });
  await migrator.connect();
  try {
    await applyTenantIsolation(migrator);
    await applySecurityAudit(migrator);
    assert.equal(await applySecurityAudit(migrator), false);
  } finally {
    await migrator.end();
  }

  async function pool(role) {
    const result = new pg.Pool({ connectionString: await roleUrl(role), max: 1, connectionTimeoutMillis: 3000 });
    t.after(() => result.end());
    return result;
  }
  const access = await pool('eduapp_access_api');
  const people = await pool('eduapp_people_api');
  const platform = await pool('eduapp_platform_worker');
  const iam = await pool('eduapp_iam_api');
  const accessTransactions = createTenantTransactions(access);
  const peopleTransactions = createTenantTransactions(people);
  const platformTransactions = createTenantTransactions(platform);
  const service = createSecurityAudit({ accessTransactions, peopleTransactions, iamPool: iam });

  const actors = Array.from({ length: 2 }, () => ({
    actor: randomUUID(), tenantId: randomUUID(), membershipId: randomUUID(), requestId: randomUUID(),
  }));
  for (const context of actors) {
    await admin.query("INSERT INTO tenancy_organization.tenants (id,slug,status) VALUES ($1,$2,'active')",
      [context.tenantId, context.tenantId]);
    await admin.query(`
      INSERT INTO identity_access.memberships (tenant_id,id,identity_id,status) VALUES ($1,$2,$3,'active')
    `, [context.tenantId, context.membershipId, context.actor]);
  }
  const [a, b] = actors;
  const resourceA = randomUUID();
  const resourceB = randomUUID();
  await service.recordTenant({
    event: 'security.role_updated.v1', principal: a, requestId: a.requestId, resourceId: resourceA,
    roleName: 'synthetic-role-name-must-not-store',
  });
  await service.recordTenant({
    event: 'security.sensitive_access.v1', principal: b, requestId: b.requestId, resourceId: resourceB,
    rawEmail: 'sensitive-fixture@test.invalid',
  });
  await service.recordTenant({
    event: 'security.sensitive_access.v1', principal: a, requestId: a.requestId, resourceId: resourceB, outcome: 'denied',
  });

  const readTenant = (tenantId) => platformTransactions.run(tenantId, async db => (
    await db.query(`
      SELECT tenant_id, actor_id, membership_id, request_id, action, resource_ref, outcome
      FROM platform_audit_jobs.audit_events WHERE action LIKE 'security.%' ORDER BY action
    `)
  ).rows);
  assert.deepEqual(await readTenant(a.tenantId), [{
    tenant_id: a.tenantId, actor_id: a.actor, membership_id: a.membershipId, request_id: a.requestId,
    action: 'security.role_updated.v1', resource_ref: resourceA, outcome: 'success',
  }, {
    tenant_id: a.tenantId, actor_id: a.actor, membership_id: a.membershipId, request_id: a.requestId,
    action: 'security.sensitive_access.v1', resource_ref: 'scope', outcome: 'denied',
  }]);
  assert.deepEqual(await readTenant(b.tenantId), [{
    tenant_id: b.tenantId, actor_id: b.actor, membership_id: b.membershipId, request_id: b.requestId,
    action: 'security.sensitive_access.v1', resource_ref: resourceB, outcome: 'success',
  }]);
  const securityAttempt = {
    event: 'security.role_assigned.v1', principal: a, requestId: a.requestId, resourceId: resourceA,
  };
  await assert.rejects(appendTenantSecurityEvent(access, securityAttempt), { code: '42501' });
  await assert.rejects(peopleTransactions.run(a.tenantId, db => appendTenantSecurityEvent(db, securityAttempt)),
    { code: '42501' });
  await assert.rejects(platformTransactions.run(a.tenantId, db => db.query(`
    INSERT INTO platform_audit_jobs.audit_events (tenant_id,actor_id,membership_id,action,resource_ref,outcome)
    VALUES ($1,$2,$3,'security.role_updated.v1',$4,'success')
  `, [a.tenantId, a.actor, a.membershipId, resourceA])), { code: '42501' });
  await assert.rejects(platformTransactions.run(a.tenantId, db => db.query('DELETE FROM platform_audit_jobs.audit_events')),
    { code: '42501' });
  await platformTransactions.run(a.tenantId, db => db.query(`
    INSERT INTO platform_audit_jobs.audit_events (tenant_id,action,resource_ref)
    VALUES ($1,'sites.page_published.v1','legacy-valid')
  `, [a.tenantId]));

  const roleId = randomUUID();
  await assert.rejects(accessTransactions.run(a.tenantId, async db => {
    await db.query(`
      INSERT INTO identity_access.roles (tenant_id,id,name,version) VALUES ($1,$2,'Fixture rollback',1)
    `, [a.tenantId, roleId]);
    await appendTenantSecurityEvent(db, { ...securityAttempt, principal: { ...a, membershipId: b.membershipId } });
  }), { code: '42501' });
  assert.equal((await admin.query('SELECT 1 FROM identity_access.roles WHERE id = $1', [roleId])).rowCount, 0);
  await admin.query("UPDATE identity_access.memberships SET status='expired' WHERE tenant_id=$1 AND id=$2",
    [a.tenantId, a.membershipId]);
  await assert.rejects(service.recordTenant(securityAttempt), { code: '42501' });

  const unidentified = randomUUID();
  const sessionId = randomUUID();
  await service.recordIam({
    outcome: 'success', actorId: a.actor, requestId: a.requestId,
    tenantId: a.tenantId, membershipId: a.membershipId, sessionId,
  });
  await appendIamSecurityEvent(iam, { outcome: 'denied', requestId: unidentified, login: 'fixture-input@test.invalid' });
  const { rows } = await admin.query(`
    SELECT actor_id, request_id, tenant_id, membership_id, session_id, outcome
    FROM identity_access.security_login_facts WHERE request_id = ANY($1) ORDER BY outcome
  `, [[a.requestId, unidentified]]);
  assert.deepEqual(rows, [
    { actor_id: null, request_id: unidentified, tenant_id: null, membership_id: null, session_id: null, outcome: 'denied' },
    {
      actor_id: a.actor, request_id: a.requestId, tenant_id: a.tenantId,
      membership_id: a.membershipId, session_id: sessionId, outcome: 'success',
    },
  ]);
  await assert.rejects(iam.query('SELECT * FROM identity_access.security_login_facts'), { code: '42501' });
  await assert.rejects(access.query('SELECT * FROM identity_access.security_login_facts'), { code: '42501' });
});
