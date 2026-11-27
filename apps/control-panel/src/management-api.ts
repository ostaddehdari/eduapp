import { createGatewayCall, GatewayRequestError } from './onboarding-api';
import { readApproval, readOverview, type Command, type ManagementMode } from './management-model';

type Session = { tenantId: string | null; accessToken: string };
type LoginInput = { login: string; password: string; tenantId: string | null };

export function createManagementClient(config: string, transport: typeof fetch = fetch) {
  const call = createGatewayCall(config, transport);
  return {
    async login({ tenantId, ...credentials }: LoginInput): Promise<Session> {
      const result = await call('/auth/login', undefined, {
        ...credentials, ...(tenantId ? { tenantId } : {}),
      }) as Partial<Session> | undefined;
      if (!result || typeof result.accessToken !== 'string' || !result.accessToken || result.tenantId !== tenantId) {
        throw new GatewayRequestError(403);
      }
      return { tenantId, accessToken: result.accessToken };
    },
    async read(session: Session, selectedTenant?: string) {
      const query = selectedTenant ? '?tenantId=' + encodeURIComponent(selectedTenant) : '';
      const overview = readOverview(await call('/management/overview' + query, session.accessToken));
      const mode: ManagementMode = session.tenantId ? 'organization' : 'platform';
      if (!overview || overview.mode !== mode ||
        (mode === 'organization' && (overview.selected?.tenant.id !== session.tenantId ||
          overview.tenants.some(tenant => tenant.id !== session.tenantId))) ||
        (mode === 'platform' && (overview.selected?.tenant.id !== selectedTenant ||
          (selectedTenant && !overview.tenants.some(tenant => tenant.id === selectedTenant))))) {
        throw new GatewayRequestError(503);
      }
      return overview;
    },
    async perform(session: Session, command: Command, code: string, isCurrent: () => boolean) {
      if (session.tenantId !== null) throw new GatewayRequestError(403);
      await call('/auth/mfa/step-up', session.accessToken, { code });
      if (!isCurrent()) throw new GatewayRequestError(401);
      const { tenantId } = command;
      const result = command.type === 'request' ? await call('/management/status-requests', session.accessToken, {
        tenantId, targetStatus: command.targetStatus, expectedVersion: command.expectedVersion,
      }) : await call('/management/status-requests/' + encodeURIComponent(command.requestId) + '/decision', session.accessToken, {
        tenantId, decision: command.decision,
      });
      const approval = readApproval(result);
      if (!approval) throw new GatewayRequestError(503);
      return approval;
    },
    async logout(session: Session) {
      await call('/auth/logout', session.accessToken, {});
    },
  };
}
