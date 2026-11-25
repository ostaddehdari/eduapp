const tenantIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const bindTenantSql = `
  SELECT pg_catalog.set_config('app.tenant_id', $1::uuid::text, true)
  WHERE NULLIF(pg_catalog.current_setting('app.tenant_id', true), '') IS NULL
`;

/**
 * Execute owned data access with the UUID the owner has already authorized.
 * The pool must authenticate as that owner runtime and supply node-postgres
 * compatible query, connect and release methods.
 */
export function createTenantTransactions(pool) {
  return Object.freeze({
    async run(verifiedTenantId, work) {
      if (typeof verifiedTenantId !== 'string' || !tenantIdPattern.test(verifiedTenantId)) {
        throw new TypeError('An authorized tenant UUID is required');
      }
      const client = await pool.connect();
      let discard = true;
      let active = false;
      try {
        await client.query('BEGIN');
        let result;
        try {
          const binding = await client.query(bindTenantSql, [verifiedTenantId]);
          if (binding.rowCount !== 1) {
            throw new Error('The database connection already has a tenant context');
          }
          discard = false;
          active = true;
          result = await work(Object.freeze({
            query(text, values) {
              if (!active) throw new Error('The tenant transaction has ended');
              return client.query(text, values);
            },
          }));
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            discard = true;
            throw new AggregateError([error, rollbackError], 'Tenant transaction cleanup failed');
          }
          throw error;
        } finally {
          active = false;
        }

        discard = true;
        const commit = await client.query('COMMIT');
        if (commit.command !== 'COMMIT') {
          throw new Error('The tenant transaction did not commit');
        }
        discard = false;
        return result;
      } finally {
        client.release(discard);
      }
    },
  });
}
