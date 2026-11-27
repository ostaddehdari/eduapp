import { readApproval, type Approval, type Command, type ManagementMode, type Overview, type Selected } from './management-model';

export type SampleScope = 'platform' | 'aftab' | 'baran';
export type SampleActor = 'requester' | 'reviewer';

const sampleId = {
  aftab: '6f61a5db-1721-45b1-aa1e-e8cc9be8a301',
  baran: '6f61a5db-1721-45b1-aa1e-e8cc9be8a302',
};
const divisions = {
  aftab: {
    displayName: 'مجموعهٔ آفتاب', division: 'شعبهٔ مرکزی آفتاب',
    branchId: '6f61a5db-1721-45b1-aa1e-e8cc9be8a303', managerId: '6f61a5db-1721-45b1-aa1e-e8cc9be8a304', limit: '120',
  },
  baran: {
    displayName: 'مجموعهٔ باران', division: 'شعبهٔ آموزشی باران',
    branchId: '6f61a5db-1721-45b1-aa1e-e8cc9be8a305', managerId: '6f61a5db-1721-45b1-aa1e-e8cc9be8a306', limit: '80',
  },
};
type Division = keyof typeof divisions;

const bucket = (tenantId: string) => 'eduapp.management.demo.v1.' + tenantId;

function readSampleApprovals(tenantId: string): Approval[] {
  try {
    const rows = JSON.parse(window.localStorage.getItem(bucket(tenantId)) ?? '[]') as unknown;
    return Array.isArray(rows) ? rows.slice(0, 20).map(readApproval).filter(row => row !== null) : [];
  } catch {
    return [];
  }
}

function parseScope(id: string): Division | undefined {
  return (Object.keys(sampleId) as Division[]).find(key => sampleId[key] === id);
}

export function sampleOverview(scope: SampleScope, actor: SampleActor, tenantId?: string): Overview {
  const mode: ManagementMode = scope === 'platform' ? 'platform' : 'organization';
  const permitted: Division[] = scope === 'platform' ? ['aftab', 'baran'] : [scope];
  const snapshots = permitted.map((key): Selected => {
    const source = divisions[key];
    const id = sampleId[key];
    const approvals = readSampleApprovals(id).map(row => ({
      ...row, canDecide: row.state === 'pending' && scope === 'platform' && actor === 'reviewer',
    }));
    const applied = approvals.filter(row => row.state === 'approved');
    return {
      tenant: { id, slug: key, displayName: source.displayName, status: applied[0]?.targetStatus ?? 'active', version: applied.length + 1 },
      branches: [{ id: source.branchId, parentId: null, kind: 'branch', code: key + '-central', name: source.division }],
      quotas: [{ feature: 'active_users', limit: source.limit, validTo: null }],
      managers: [{ membershipId: source.managerId, orgUnitId: source.branchId, roleName: 'مدیر نمونهٔ ' + source.displayName }],
      approvals,
      permissions: { requestStatusChange: scope === 'platform' && actor === 'requester',
        decideStatusChange: scope === 'platform' && actor === 'reviewer' },
    };
  });
  return {
    mode, tenants: snapshots.map(({ tenant }) => tenant),
    selected: snapshots.find(({ tenant }) => tenant.id === tenantId) ?? snapshots[0] ?? null,
  };
}

export function performSample(actor: SampleActor, command: Command): Approval {
  if (!parseScope(command.tenantId)) throw new Error('INVALID_SAMPLE_SCOPE');
  const selected = sampleOverview('platform', actor, command.tenantId).selected;
  if (!selected) throw new Error('SAMPLE_NOT_FOUND');
  const timestamp = new Date().toISOString();
  let result: Approval;
  let approvals: Approval[];
  if (command.type === 'request') {
    if (!selected.permissions.requestStatusChange || selected.tenant.version !== command.expectedVersion ||
      selected.tenant.status === command.targetStatus || selected.approvals.some(row => row.state === 'pending')) {
      throw new Error('SAMPLE_REQUEST_CONFLICT');
    }
    result = { id: crypto.randomUUID(), targetStatus: command.targetStatus, state: 'pending',
      expectedVersion: command.expectedVersion, requestedAt: timestamp, decidedAt: null, canDecide: false };
    approvals = [result, ...selected.approvals].slice(0, 20);
  } else {
    const current = selected.approvals.find(row => row.id === command.requestId);
    if (!current?.canDecide) throw new Error('SAMPLE_REVIEW_REQUIRES_OTHER_ACTOR');
    const state = current.expectedVersion !== selected.tenant.version ? 'stale' :
      command.decision === 'approve' ? 'approved' : 'rejected';
    result = { ...current, state, decidedAt: timestamp, canDecide: false };
    approvals = selected.approvals.map(row => row.id === result.id ? result : row);
  }
  window.localStorage.setItem(bucket(command.tenantId), JSON.stringify(approvals));
  return result;
}
