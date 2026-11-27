import { useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { formatPersianTimestamp } from '@eduapp/ui-tokens/preview';
import { GatewayRequestError } from './onboarding-api';
import { toAsciiDigits, uuidPattern } from './onboarding-model';
import { createManagementClient } from './management-api';
import { performSample, sampleOverview } from './management-demo';
import type { SampleActor, SampleScope } from './management-demo';
import type { Approval, Command, ManagementMode, Overview, Selected, TargetStatus } from './management-model';
import './management.css';

const number = new Intl.NumberFormat('fa-IR');
const customerStatus: Readonly<Record<string, string>> = { active: 'فعال', suspended: 'معلق', deleted: 'حذف‌شده' };
const kindLabels: Readonly<Record<string, string>> = {
  holding: 'هلدینگ', company: 'شرکت', collection: 'مجموعه', branch: 'شعبه', school: 'مدرسه', institute: 'آموزشگاه',
};
const features: Readonly<Record<string, string>> = { active_users: 'کاربران فعال', schools: 'مدرسه‌ها', storage: 'فضای ذخیره‌سازی' };
const reviewStatus: Readonly<Record<Approval['state'], string>> = {
  pending: 'در انتظار بررسی', approved: 'تأیید شد', rejected: 'رد شد', stale: 'نیازمند درخواست جدید',
};
const actions: Readonly<Record<TargetStatus, string>> = { active: 'بازفعال‌سازی', suspended: 'تعلیق' };

function message(error: unknown) {
  if (!(error instanceof GatewayRequestError)) return 'عملیات کامل نشد. وضعیت را بررسی و دوباره تلاش کنید.';
  switch (error.status) {
    case 401: return 'ورود یا تأیید هویت انجام نشد. اطلاعات حساب و کد تأیید را بررسی کنید.';
    case 403: return 'مجوز لازم وجود ندارد. درخواست حساس باید توسط فرد مجاز دیگری بررسی شود.';
    case 409:
    case 412: return 'وضعیت تغییر کرده یا در انتظار بررسی است. اطلاعات را به‌روز کنید.';
    case 429: return 'تعداد تلاش‌ها زیاد است. کمی بعد دوباره تلاش کنید.';
    default: return 'سرویس مدیریت در دسترس نیست. دوباره تلاش کنید.';
  }
}

function Tag({ value, children }: { value: string; children: ReactNode }) {
  return <span className="management-tag" data-state={value}>{children}</span>;
}

function Card({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section className="management-card edu-card" aria-labelledby={id}>
    <h2 id={id}>{title}</h2>{children}
  </section>;
}

function SelectedCards({ selected }: { selected: Selected }) {
  const units = new Map(selected.branches.map(unit => [unit.id, unit.name]));
  return <div className="management-metrics">
    <Card id="management-branches" title="شعب و واحدها">
      {selected.branches.length ? <ul className="management-list">
        {selected.branches.map(branch => <li key={branch.id}>
          <div><strong>{branch.name}</strong><small>{kindLabels[branch.kind] ?? 'واحد سازمانی'}</small></div>
          <bdi className="management-code">{branch.code}</bdi>
        </li>)}
      </ul> : <p className="management-empty">واحدی در این محدوده ثبت نشده است.</p>}
    </Card>
    <Card id="management-quotas" title="سهمیه‌ها">
      {selected.quotas.length ? <ul className="management-list">
        {selected.quotas.map(quota => <li key={quota.feature}>
          <div><strong>{features[quota.feature] ?? quota.feature}</strong>
            {quota.validTo && <small>تا {formatPersianTimestamp(quota.validTo) ?? 'تاریخ ثبت‌شده'}</small>}</div>
          <strong>{quota.limit === null ? 'بدون سقف' : number.format(BigInt(quota.limit))}</strong>
        </li>)}
      </ul> : <p className="management-empty">سهمیه‌ای در این محدوده قابل مشاهده نیست.</p>}
    </Card>
    <Card id="management-managers" title="مدیران و نقش‌ها">
      {selected.managers.length ? <ul className="management-list">
        {selected.managers.map(manager => <li key={JSON.stringify([manager.membershipId, manager.orgUnitId, manager.roleName])}>
          <div><strong>{manager.roleName}</strong>
            <small>{manager.orgUnitId ? units.get(manager.orgUnitId) ?? 'واحد مجاز' : 'کل مجموعه'}</small></div>
        </li>)}
      </ul> : <p className="management-empty">مدیری در این محدوده قابل مشاهده نیست.</p>}
    </Card>
  </div>;
}

function SecureActions({ demo, pending, approvalId, buttons, run }: {
  demo: boolean;
  pending: boolean;
  approvalId: string;
  buttons: ReadonlyArray<{ value: string; label: string; secondary?: boolean }>;
  run: (choice: string, code: string) => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const choice = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') ?? buttons[0]?.value;
    const verification = event.currentTarget.elements.namedItem('code');
    if (verification instanceof HTMLInputElement) verification.value = '';
    if (choice) run(choice, toAsciiDigits(String(data.get('code') ?? '')));
  }

  return <form className="management-actions" onSubmit={submit}>
    {!demo && <label className="setup-field">
      <span>کد تأیید دومرحله‌ای</span>
      <input required pattern="[0-9۰-۹٠-٩]{6}" name="code" aria-describedby={approvalId} dir="ltr"
        type="password" inputMode="numeric" autoComplete="one-time-code" maxLength={6} disabled={pending} />
    </label>}
    <div className="management-buttons">
      {buttons.map(button => <button type="submit" key={button.value} value={button.value} disabled={pending}
        className={'setup-button ' + (button.secondary ? 'setup-secondary' : 'setup-primary')}>{button.label}</button>)}
    </div>
  </form>;
}

function Approvals({ selected, demo, pending, run }: {
  selected: Selected; demo: boolean; pending: boolean; run: (command: Command, code: string) => void;
}) {
  const { tenant, permissions, approvals } = selected;
  const target = tenant.status === 'active' ? 'suspended' : tenant.status === 'suspended' ? 'active' : null;
  return <Card id="management-approvals" title="درخواست‌های حساس">
    {permissions.requestStatusChange && target !== null && !approvals.some(approval => approval.state === 'pending') &&
      <div className="management-request">
        <div><strong>درخواست {actions[target]}</strong>
          <p id="management-request-hint">تغییر وضعیت پس از بررسی و تأیید یک فرد مجاز دیگر انجام می‌شود.</p></div>
        <SecureActions demo={demo} pending={pending} approvalId="management-request-hint"
          buttons={[{ value: 'request', label: 'ثبت درخواست ' + actions[target] }]}
          run={(_, code) => run({
            type: 'request', tenantId: tenant.id, targetStatus: target, expectedVersion: tenant.version,
          }, code)} />
      </div>}
    {approvals.length ? <ul className="management-list management-approval-list">
      {approvals.map(approval => {
        const description = 'review-' + approval.id;
        return <li key={approval.id}>
          <div className="management-approval-head"><strong>درخواست {actions[approval.targetStatus]}</strong>
            <Tag value={approval.state}>{reviewStatus[approval.state]}</Tag></div>
          <small>{formatPersianTimestamp(approval.requestedAt) ?? 'زمان ثبت در دسترس نیست'}</small>
          {approval.state === 'pending' && permissions.decideStatusChange && approval.canDecide ?
            <><p id={description}>پس از بررسی، درخواست را تأیید یا رد کنید.</p>
              <SecureActions demo={demo} pending={pending} approvalId={description}
                buttons={[{ value: 'approve', label: 'تأیید درخواست' }, { value: 'reject', label: 'رد درخواست', secondary: true }]}
                run={(choice, code) => run({
                  type: 'decision', tenantId: tenant.id, requestId: approval.id,
                  decision: choice === 'reject' ? 'reject' : 'approve',
                }, code)} />
            </> : approval.state === 'pending' &&
              <p>در انتظار بررسی یک تأییدکنندهٔ دیگر است.</p>}
        </li>;
      })}
    </ul> : <p className="management-empty">درخواستی در این محدوده ثبت نشده است.</p>}
  </Card>;
}

type WorkspaceProps = {
  overview: Overview;
  demo: boolean;
  select: (tenantId: string) => Promise<void>;
  perform: (command: Command, code: string) => Promise<Approval>;
};

function Workspace({ overview, demo, select, perform }: WorkspaceProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const selection = useRef<HTMLElement>(null);
  const { selected } = overview;

  async function selectCustomer(id: string) {
    if (pending) return;
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await select(id);
      requestAnimationFrame(() => selection.current?.focus());
    } catch (caught) {
      setError(message(caught));
    } finally {
      setPending(false);
    }
  }

  async function execute(command: Command, code: string) {
    if (pending) return;
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const approval = await perform(command, code);
      setNotice(approval.state === 'stale' ? 'نسخه تغییر کرده است. درخواست جدید لازم است.' : demo ?
        'نتیجهٔ تمرینی ثبت شد.' : command.type === 'request' ?
          'درخواست برای بررسی ثبت شد.' : 'نتیجهٔ بررسی ثبت شد.');
    } catch (caught) {
      setError(message(caught));
    } finally {
      setPending(false);
    }
  }

  return <div aria-busy={pending}>
    <Card id="management-customers" title={overview.mode === 'platform' ? 'مشتریان مجاز' : 'مجموعهٔ فعال'}>
      {overview.tenants.length ? <ul className="management-customers">
        {overview.tenants.map(tenant => <li key={tenant.id}>
          {overview.mode === 'platform' ?
            <button type="button" className="management-customer" disabled={pending} aria-pressed={selected?.tenant.id === tenant.id}
              onClick={() => void selectCustomer(tenant.id)}>
              <span><strong>{tenant.displayName}</strong><small><bdi>{tenant.slug}</bdi></small></span>
              <Tag value={tenant.status}>{customerStatus[tenant.status] ?? 'وضعیت ثبت‌شده'}</Tag>
            </button> : <div className="management-customer">
              <span><strong>{tenant.displayName}</strong><small><bdi>{tenant.slug}</bdi></small></span>
              <Tag value={tenant.status}>{customerStatus[tenant.status] ?? 'وضعیت ثبت‌شده'}</Tag>
            </div>}
        </li>)}
      </ul> : <p className="management-empty">مجموعه‌ای در محدودهٔ شما یافت نشد.</p>}
    </Card>
    {error && <p role="alert" className="edu-error management-feedback">{error}</p>}
    {notice && <p role="status" className="setup-note management-feedback">{notice}</p>}
    {selected ? <>
      <header className="management-scope" tabIndex={-1} ref={selection}>
        <h2>{selected.tenant.displayName}</h2>
        <p>جزئیات همین مجموعه</p>
      </header>
      <SelectedCards selected={selected} />
      <Approvals selected={selected} demo={demo} pending={pending} run={(command, code) => void execute(command, code)} />
    </> : overview.tenants.length > 0 && <p className="management-empty">یک مجموعه را برای دیدن جزئیات انتخاب کنید.</p>}
  </div>;
}

function SampleWorkspace({ scope }: { scope: SampleScope }) {
  const [actor, setActor] = useState<SampleActor>('requester');
  const [selectedId, setSelectedId] = useState<string>();
  const [, refreshSnapshot] = useState(0);
  const snapshot = sampleOverview(scope, actor, selectedId);
  return <>
    {scope === 'platform' && <label className="setup-field management-role"><span>نقش تمرینی</span>
      <select value={actor} onChange={event => setActor(event.currentTarget.value as SampleActor)}>
        <option value="requester">درخواست‌دهنده</option>
        <option value="reviewer">بازبین دوم</option>
      </select>
    </label>}
    <Workspace key={actor} overview={snapshot} demo
      select={async tenantId => setSelectedId(tenantId)}
      perform={async command => {
        const result = performSample(actor, command);
        refreshSnapshot(value => value + 1);
        return result;
      }} />
  </>;
}

type Client = ReturnType<typeof createManagementClient>;
type Session = Awaited<ReturnType<Client['login']>>;

function LiveWorkspace({ client }: { client: Client }) {
  const active = useRef<Session>(undefined);
  const [mode, setMode] = useState<ManagementMode>('organization');
  const [session, setSession] = useState<Session>();
  const [overview, setOverview] = useState<Overview>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const password = event.currentTarget.elements.namedItem('password');
    if (password instanceof HTMLInputElement) password.value = '';
    setPending(true);
    setError(undefined);
    try {
      const account = await client.login({
        login: String(data.get('login') ?? '').trim(), password: String(data.get('password') ?? ''),
        tenantId: mode === 'platform' ? null : String(data.get('tenantId') ?? '').trim().toLowerCase(),
      });
      const approved = await client.read(account);
      active.current = account;
      setSession(account);
      setOverview(approved);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setPending(false);
    }
  }

  if (!session || !overview) return <section className="edu-card setup-login" aria-labelledby="management-login">
    <header className="setup-card-top"><h2 id="management-login">ورود به پنل مدیریت</h2></header>
    <form onSubmit={login} className="setup-card-content">
      <fieldset className="setup-fields" disabled={pending}>
        <legend className="setup-visually-hidden">اطلاعات ورود</legend>
        <label className="setup-field"><span>نوع دسترسی</span>
          <select name="mode" value={mode} onChange={event => setMode(event.currentTarget.value as ManagementMode)}>
            <option value="organization">مدیر مجموعه</option><option value="platform">مالک پلتفرم</option>
          </select>
        </label>
        <label className="setup-field"><span>ایمیل حساب</span>
          <input required name="login" type="email" dir="ltr" maxLength={254} autoComplete="username" />
        </label>
        <label className="setup-field"><span>رمز عبور</span>
          <input required name="password" type="password" dir="ltr" maxLength={1024} autoComplete="current-password" />
        </label>
        {mode === 'organization' && <label className="setup-field"><span>شناسهٔ مجموعه</span>
          <input required name="tenantId" dir="ltr" maxLength={36} pattern={uuidPattern} autoComplete="off" spellCheck={false}/>
        </label>}
      </fieldset>
      {error && <p role="alert" className="edu-error management-feedback">{error}</p>}
      <div className="management-buttons"><button className="setup-button setup-primary" disabled={pending} type="submit">
        {pending ? 'در حال ورود…' : 'ورود به مدیریت'}
      </button></div>
    </form>
  </section>;

  async function select(tenantId: string) {
    if (!session || active.current !== session) throw new GatewayRequestError(401);
    const next = await client.read(session, tenantId);
    if (active.current === session) setOverview(next);
  }

  return <>
    <div className="management-session">
      <p>{overview.mode === 'platform' ? 'دسترسی مالک پلتفرم' : 'دسترسی مدیر مجموعه'}</p>
      <div className="management-buttons">
        <button type="button" className="setup-button setup-secondary"
          onClick={() => void client.read(session, overview.mode === 'platform' ? overview.selected?.tenant.id : undefined)
            .then(next => { if (active.current === session) { setOverview(next); setError(undefined); } })
            .catch(caught => { if (active.current === session) setError(message(caught)); })}>به‌روزرسانی اطلاعات</button>
        <button type="button" className="setup-button setup-secondary" onClick={() => {
          active.current = undefined;
          setSession(undefined);
          setOverview(undefined);
          setError(undefined);
          void client.logout(session).catch(() => {});
        }}>خروج از حساب</button>
      </div>
    </div>
    {error && <p role="alert" className="edu-error management-feedback">{error}</p>}
    <Workspace overview={overview} demo={false} select={select}
      perform={async (command, code) => {
        if (active.current !== session) throw new GatewayRequestError(401);
        const approval = await client.perform(session, command, code, () => active.current === session);
        if (active.current === session) await select(command.tenantId);
        return approval;
      }} />
  </>;
}

const sampleLinks: ReadonlyArray<[SampleScope, string]> = [
  ['platform', 'مالک پلتفرم'], ['aftab', 'مدیر آفتاب'], ['baran', 'مدیر باران'],
];

export function Management({ configuredApi, sample }: { configuredApi?: string; sample: string }) {
  const demo = configuredApi === undefined;
  const scope: SampleScope = sample === 'aftab' || sample === 'baran' ? sample : 'platform';
  let client;
  if (configuredApi !== undefined) {
    try { client = createManagementClient(configuredApi); } catch { client = null; }
  }

  return <main id="main" tabIndex={-1} className="edu-frame management-main">
    <header className="management-intro">
      <p className="setup-section-label">{demo ? 'پیش‌نمایش آموزشی' : 'پنل مدیریت EduApp'}</p>
      <h1>مدیریت پلتفرم و مجموعه</h1>
      <p>مشتریان، واحدهای آموزشی، سهمیه‌ها، مدیران و درخواست‌های حساس در محدودهٔ دسترسی شما.</p>
    </header>
    {demo ? <>
      <div className="setup-demo-strip">
        <p>اطلاعات و تأییدها نمونه‌اند و هیچ تغییر واقعی در سامانه ایجاد نمی‌کنند.</p>
        <nav className="edu-school-links" aria-label="محدودهٔ تمرینی">
          {sampleLinks.map(([id, label]) => <a key={id} href={'?view=management&sample=' + id}
            aria-current={scope === id ? 'true' : undefined}>{label}</a>)}
        </nav>
      </div>
      <SampleWorkspace key={scope} scope={scope} />
    </> : client ? <LiveWorkspace client={client} /> :
      <p role="alert" className="edu-error">نشانی سرویس مدیریت معتبر نیست.</p>}
  </main>;
}
