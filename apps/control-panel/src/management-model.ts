export type ManagementMode = 'platform' | 'organization';
export type TargetStatus = 'active' | 'suspended';
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'stale';

export type Customer = { id: string; slug: string; displayName: string; status: string; version: number };
export type Branch = { id: string; parentId: string | null; kind: string; code: string; name: string };
export type Quota = { feature: string; limit: string | null; validTo: string | null };
export type Manager = { membershipId: string; orgUnitId: string | null; roleName: string };
export type Approval = {
  id: string;
  targetStatus: TargetStatus;
  state: ApprovalState;
  expectedVersion: number;
  requestedAt: string;
  decidedAt: string | null;
  canDecide: boolean;
};
export type Selected = {
  tenant: Customer;
  branches: Branch[];
  quotas: Quota[];
  managers: Manager[];
  approvals: Approval[];
  permissions: { requestStatusChange: boolean; decideStatusChange: boolean };
};
export type Overview = { mode: ManagementMode; tenants: Customer[]; selected: Selected | null };
export type Command =
  | { type: 'request'; tenantId: string; targetStatus: TargetStatus; expectedVersion: number }
  | { type: 'decision'; tenantId: string; requestId: string; decision: 'approve' | 'reject' };

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const id = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && uuid.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const version = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const date = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
const nullableId = (value: unknown): value is string | null => value === null || id(value);
const nullableDate = (value: unknown): value is string | null => value === null || date(value);
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

function readCustomer(value: unknown): Customer | null {
  const row = object(value);
  if (!row || !id(row.id) || !text(row.slug) || !text(row.displayName) || !text(row.status) || !version(row.version)) return null;
  return { id: row.id, slug: row.slug, displayName: row.displayName, status: row.status, version: row.version };
}

function readBranch(value: unknown): Branch | null {
  const row = object(value);
  if (!row || !id(row.id) || !nullableId(row.parentId) || !text(row.kind) || !text(row.code) || !text(row.name)) return null;
  return { id: row.id, parentId: row.parentId, kind: row.kind, code: row.code, name: row.name };
}

function readQuota(value: unknown): Quota | null {
  const row = object(value);
  if (!row || !text(row.feature) || !nullableDate(row.validTo) ||
    (row.limit !== null && (!text(row.limit) || !/^\d{1,19}$/.test(row.limit)))) return null;
  return { feature: row.feature, limit: row.limit, validTo: row.validTo };
}

function readManager(value: unknown): Manager | null {
  const row = object(value);
  if (!row || !id(row.membershipId) || !nullableId(row.orgUnitId) || !text(row.roleName)) return null;
  return { membershipId: row.membershipId, orgUnitId: row.orgUnitId, roleName: row.roleName };
}

export function readApproval(value: unknown): Approval | null {
  const row = object(value);
  if (!row || !id(row.id) || !version(row.expectedVersion) || !date(row.requestedAt) || !nullableDate(row.decidedAt) ||
    (row.targetStatus !== 'active' && row.targetStatus !== 'suspended') ||
    (row.state !== 'pending' && row.state !== 'approved' && row.state !== 'rejected' && row.state !== 'stale')) return null;
  return {
    id: row.id, targetStatus: row.targetStatus, state: row.state, expectedVersion: row.expectedVersion,
    requestedAt: row.requestedAt, decidedAt: row.decidedAt, canDecide: row.canDecide === true,
  };
}

function list<T>(value: unknown, read: (row: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const rows = value.map(read);
  if (rows.some(row => row === null)) return null;
  return rows as T[];
}

export function readOverview(value: unknown): Overview | null {
  const overview = object(value);
  if (!overview || (overview.mode !== 'platform' && overview.mode !== 'organization')) return null;
  const tenants = list(overview.tenants, readCustomer);
  if (!tenants) return null;
  if (overview.selected === null) return { mode: overview.mode, tenants, selected: null };
  const selected = object(overview.selected);
  const tenant = readCustomer(selected?.tenant);
  const branches = list(selected?.branches, readBranch);
  const quotas = list(selected?.quotas, readQuota);
  const managers = list(selected?.managers, readManager);
  const approvals = list(selected?.approvals, readApproval);
  const permissions = object(selected?.permissions);
  if (!tenant || !branches || !quotas || !managers || !approvals || !permissions ||
    typeof permissions.requestStatusChange !== 'boolean' || typeof permissions.decideStatusChange !== 'boolean') return null;
  return {
    mode: overview.mode, tenants, selected: {
      tenant, branches, quotas, managers, approvals,
      permissions: { requestStatusChange: permissions.requestStatusChange, decideStatusChange: permissions.decideStatusChange },
    },
  };
}
