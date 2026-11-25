export function welcomeTitle(tenantName: string): string {
  const name = tenantName.trim();
  if (!name) throw new Error('TENANT_NAME_REQUIRED');
  return `خوش آمدید، ${name}`;
}
