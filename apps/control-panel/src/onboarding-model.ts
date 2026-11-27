export const organizationKinds = [
  ['collection', 'مجموعهٔ آموزشی'],
  ['holding', 'هلدینگ آموزشی'],
  ['company', 'شرکت آموزشی'],
  ['school', 'مدرسه'],
  ['institute', 'آموزشگاه'],
] as const;

export type OrganizationKind = typeof organizationKinds[number][0];
export type SchoolLayout = 'standalone' | 'branch';
export const steps = ['organization', 'school', 'invitation', 'site', 'completed'] as const;
export type Step = typeof steps[number];

export type OrganizationInput = { kind: OrganizationKind; name: string; code: string };
export type SchoolInput = { layout: SchoolLayout; name: string; code: string; branchName?: string; branchCode?: string };
export type InvitationInput = { identityId: string };
export type SiteInput = { name: string; slug: string };

export type Advance =
  | { step: 'organization'; input: OrganizationInput }
  | { step: 'school'; input: SchoolInput }
  | { step: 'invitation'; input: InvitationInput }
  | { step: 'site'; input: SiteInput };

export type Draft = {
  organization?: OrganizationInput & { orgUnitId?: string };
  school?: SchoolInput & { orgUnitId?: string };
  invitation?: InvitationInput & { invitationId?: string; status?: string };
  site?: SiteInput & { siteId?: string; status?: string };
};

export type OnboardingState = { version: number; step: Step; draft: Draft };

export const demoSchools = {
  aftab: { label: 'مدرسهٔ آفتاب', name: 'آفتاب', code: 'aftab', manager: 'مدیر نمونهٔ آفتاب' },
  baran: { label: 'مدرسهٔ باران', name: 'باران', code: 'baran', manager: 'مدیر نمونهٔ باران' },
} as const;

export type DemoSchool = keyof typeof demoSchools;

type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const initialState = (): OnboardingState => ({ version: 0, step: 'organization', draft: {} });
export const scopeKey = (school: DemoSchool) => `eduapp.onboarding.demo.v1.${school}`;
export const canHaveBranch = (kind?: OrganizationKind) => kind === 'collection' || kind === 'company';
export const codePattern = '[a-z0-9]+(?:-[a-z0-9]+)*';
export const uuidPattern = '[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}';

export function toAsciiDigits(value: string): string {
  return value.replace(/[۰-۹٠-٩]/g, digit => String((digit.charCodeAt(0) & 15)));
}

export function advanceDemo(state: OnboardingState, next: Advance): OnboardingState {
  if (state.step !== next.step) throw new Error('ONBOARDING_STEP_MISMATCH');
  const version = state.version + 1;
  const draft = state.draft;
  switch (next.step) {
    case 'organization': return { version, step: 'school', draft: { ...draft, organization: next.input } };
    case 'school': return { version, step: 'invitation', draft: { ...draft, school: next.input } };
    case 'invitation': return {
      version, step: 'site', draft: { ...draft, invitation: { ...next.input, status: 'example' } },
    };
    case 'site': return {
      version, step: 'completed', draft: { ...draft, site: { ...next.input, status: 'example' } },
    };
  }
}

function object(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
}

function nonEmpty(input: unknown): input is string {
  return typeof input === 'string' && input.trim().length > 0;
}

export function readOnboardingState(input: unknown): OnboardingState | null {
  const state = object(input);
  const draft = object(state?.draft);
  if (!state || !draft || typeof state.version !== 'number' || !Number.isSafeInteger(state.version) || state.version < 0 ||
    !steps.some(step => step === state.step)) return null;
  const required = steps.indexOf(state.step as Step);
  const org = object(draft.organization);
  const school = object(draft.school);
  const invitation = object(draft.invitation);
  const site = object(draft.site);
  const projected: Draft = {};
  if (required > 0) {
    if (!org || !nonEmpty(org.name) || !nonEmpty(org.code) ||
      !organizationKinds.some(([kind]) => kind === org.kind)) return null;
    projected.organization = { name: org.name, code: org.code, kind: org.kind as OrganizationKind,
      ...(nonEmpty(org.orgUnitId) ? { orgUnitId: org.orgUnitId } : {}) };
  }
  if (required > 1) {
    if (!school || !nonEmpty(school.name) || !nonEmpty(school.code) ||
      (school.layout !== 'standalone' && (school.layout !== 'branch' ||
        !nonEmpty(school.branchName) || !nonEmpty(school.branchCode)))) return null;
    projected.school = { name: school.name, code: school.code, layout: school.layout,
      ...(nonEmpty(school.branchName) ? { branchName: school.branchName } : {}),
      ...(nonEmpty(school.branchCode) ? { branchCode: school.branchCode } : {}),
      ...(nonEmpty(school.orgUnitId) ? { orgUnitId: school.orgUnitId } : {}) };
  }
  if (required > 2) {
    if (!invitation || !nonEmpty(invitation.identityId)) return null;
    projected.invitation = { identityId: invitation.identityId,
      ...(nonEmpty(invitation.invitationId) ? { invitationId: invitation.invitationId } : {}),
      ...(nonEmpty(invitation.status) ? { status: invitation.status } : {}) };
  }
  if (required > 3) {
    if (!site || !nonEmpty(site.name) || !nonEmpty(site.slug)) return null;
    projected.site = { name: site.name, slug: site.slug,
      ...(nonEmpty(site.siteId) ? { siteId: site.siteId } : {}),
      ...(nonEmpty(site.status) ? { status: site.status } : {}) };
  }
  return { version: state.version, step: state.step as Step, draft: projected };
}

export function restoreDemo(storage: StoragePort, school: DemoSchool): OnboardingState {
  try {
    const data = JSON.parse(storage.getItem(scopeKey(school)) ?? 'null') as unknown;
    const state = readOnboardingState(data);
    if (!state || (state.draft.invitation && state.draft.invitation.identityId !== school)) return initialState();
    return state;
  } catch {
    return initialState();
  }
}

export function persistDemo(storage: StoragePort, school: DemoSchool, state: OnboardingState): boolean {
  try {
    storage.setItem(scopeKey(school), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearDemo(storage: StoragePort, school: DemoSchool): boolean {
  try {
    storage.removeItem(scopeKey(school));
    return true;
  } catch {
    return false;
  }
}
