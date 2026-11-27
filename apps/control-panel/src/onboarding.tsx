import { useEffect, useRef, useState } from 'react';
import type { FormEvent, InputHTMLAttributes } from 'react';
import {
  canHaveBranch, clearDemo, codePattern, demoSchools, initialState, organizationKinds, advanceDemo,
  persistDemo, readOnboardingState, restoreDemo, steps, toAsciiDigits, uuidPattern,
} from './onboarding-model';
import type { Advance, DemoSchool, OnboardingState, OrganizationKind, SchoolLayout } from './onboarding-model';
import { createOnboardingClient, GatewayRequestError } from './onboarding-api';
import type { OnboardingClient, Session } from './onboarding-api';
import './onboarding.css';

const stepLabels = ['مشخصات مجموعه', 'تعریف مدرسه', 'دعوت مدیر', 'نخستین سایت'];
const number = new Intl.NumberFormat('fa-IR');
const organizationTitle = (kind?: OrganizationKind) => organizationKinds.find(([value]) => value === kind)?.[1];
const storagePort = {
  getItem: (key: string) => window.localStorage.getItem(key),
  setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
  removeItem: (key: string) => window.localStorage.removeItem(key),
};

function errorMessage(error: unknown) {
  if (!(error instanceof GatewayRequestError)) return 'ارتباط برقرار نشد. دوباره تلاش کنید.';
  switch (error.status) {
    case 401: return 'ورود یا تأیید هویت انجام نشد. اطلاعات و کد تأیید را بررسی کنید.';
    case 403: return 'برای ادامه به عضویت فعال و دسترسی مدیریت این مجموعه نیاز دارید.';
    case 404: return 'اطلاعات موردنیاز در محدودهٔ این مجموعه پیدا نشد.';
    case 409:
    case 412: return 'پیشرفت تغییر کرده است. آخرین وضعیت را دوباره دریافت کنید.';
    case 400:
    case 422: return 'مقادیر واردشده را بررسی کنید. برای کدها فقط حروف کوچک لاتین، عدد و خط تیره وارد کنید.';
    case 429: return 'تعداد تلاش‌ها زیاد است. کمی بعد دوباره امتحان کنید.';
    default: return 'سرویس راه‌اندازی در دسترس نیست. دوباره تلاش کنید.';
  }
}

function Field({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return <label className="setup-field"><span>{label}</span><input required {...props} /></label>;
}

function CodeField({ label, name, defaultValue }: { label: string; name: string; defaultValue: string | undefined }) {
  return <Field label={label} name={name} dir="ltr" maxLength={64} pattern={codePattern}
    defaultValue={defaultValue} placeholder="example-school" autoComplete="off" spellCheck={false}
    title="حروف کوچک لاتین، عدد و خط تیره" />;
}

function readText(data: FormData, key: string) {
  return String(data.get(key) ?? '').trim();
}

function readStep(step: OnboardingState['step'], form: HTMLFormElement, demo?: DemoSchool): Advance | null {
  const data = new FormData(form);
  switch (step) {
    case 'organization':
      return { step, input: {
        kind: readText(data, 'kind') as OrganizationKind,
        name: readText(data, 'name'), code: readText(data, 'code'),
      } };
    case 'school': {
      const layout = readText(data, 'layout') as SchoolLayout;
      return { step, input: {
        layout, name: readText(data, 'name'), code: readText(data, 'code'),
        ...(layout === 'branch' ? { branchName: readText(data, 'branchName'), branchCode: readText(data, 'branchCode') } : {}),
      } };
    }
    case 'invitation': return { step, input: { identityId: demo ?? readText(data, 'identityId').toLowerCase() } };
    case 'site': return { step, input: { name: readText(data, 'name'), slug: readText(data, 'slug') } };
    case 'completed': return null;
  }
}

function StepFields({ state, demo }: { state: OnboardingState; demo: DemoSchool | undefined }) {
  const [layout, setLayout] = useState<SchoolLayout>('standalone');
  const example = demo && demoSchools[demo];
  const organization = state.draft.organization;
  switch (state.step) {
    case 'organization':
      return <>
        <label className="setup-field"><span>نوع مجموعه</span>
          <select name="kind" defaultValue="collection">
            {organizationKinds.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
          </select>
        </label>
        <Field label="نام مجموعه" name="name" maxLength={120} autoComplete="organization"
          defaultValue={example ? 'مجموعهٔ آموزشی ' + example.name : undefined} />
        <CodeField label="کد مجموعه" name="code" defaultValue={example ? example.code + '-group' : undefined} />
      </>;
    case 'school':
      return <>
        <label className="setup-field"><span>ساختار مدرسه</span>
          <select name="layout" value={layout} onChange={event => setLayout(event.currentTarget.value as SchoolLayout)}>
            <option value="standalone">مدرسهٔ مستقل</option>
            {canHaveBranch(organization?.kind) && <option value="branch">مدرسه در ساختار شعبه‌ای</option>}
          </select>
        </label>
        <Field label="نام مدرسه" name="name" maxLength={120} defaultValue={example ? example.label : undefined} />
        <CodeField label="کد مدرسه" name="code" defaultValue={example?.code} />
        {layout === 'branch' && <>
          <Field label="نام نخستین شعبه" name="branchName" maxLength={120}
            defaultValue={example ? 'شعبهٔ مرکزی ' + example.name : undefined} />
          <CodeField label="کد شعبه" name="branchCode" defaultValue={example ? example.code + '-central' : undefined} />
        </>}
      </>;
    case 'invitation':
      return example ? <div className="setup-note" role="note">
        <strong>{example.manager}</strong>
        <p>این مرحله فقط ثبت دعوت را شبیه‌سازی می‌کند.</p>
      </div> : <>
        <Field label="شناسهٔ کاربری مدیر" name="identityId" dir="ltr" pattern={uuidPattern} maxLength={36}
          autoComplete="off" spellCheck={false} />
        <Field label="کد تأیید دومرحله‌ای" name="verificationCode" dir="ltr" type="password"
          inputMode="numeric" autoComplete="one-time-code" minLength={6} maxLength={6} pattern="[0-9۰-۹٠-٩]{6}" />
        <p className="setup-hint">کد شش‌رقمی برنامهٔ تأیید هویت حساب خود را وارد کنید.</p>
      </>;
    case 'site':
      return <>
        <Field label="نام سایت مدرسه" name="name" maxLength={120}
          defaultValue={state.draft.school?.name} />
        <CodeField label="شناسهٔ نشانی سایت" name="slug" defaultValue={state.draft.school?.code} />
        <p className="setup-hint">{example ? 'نشانی در این تمرین صرفاً نمونه است.' : 'این مرحله پیش‌نویس سایت را آماده می‌کند.'}</p>
      </>;
    case 'completed': return null;
  }
}

type WorkspaceProps = {
  state: OnboardingState;
  demo?: DemoSchool;
  advance: (state: OnboardingState, next: Advance, verificationCode: string) => Promise<void>;
  reload?: () => Promise<void>;
  reset?: () => void;
  notice?: string | undefined;
};

function Workspace({ state, demo, advance, reload, reset, notice }: WorkspaceProps) {
  const stepIndex = steps.indexOf(state.step);
  const completed = state.step === 'completed';
  const heading = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(state.step);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (previousStep.current !== state.step) heading.current?.focus();
    previousStep.current = state.step;
  }, [state.step]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const next = readStep(state.step, form, demo);
    if (!next) return;
    const code = toAsciiDigits(String(new FormData(form).get('verificationCode') ?? ''));
    const verification = form.elements.namedItem('verificationCode');
    if (verification instanceof HTMLInputElement) verification.value = '';
    setPending(true);
    setError(undefined);
    try {
      await advance(state, next, code);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  async function refresh() {
    if (!reload || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return <div className="setup-workspace">
    <aside className="setup-progress" aria-label="مراحل راه‌اندازی">
      <p className="setup-progress-heading">پیشرفت راه‌اندازی</p>
      <ol>
        {stepLabels.map((label, index) => <li key={label}
          aria-current={index === stepIndex ? 'step' : undefined} className={index < stepIndex ? 'setup-step-done' : undefined}>
          <span aria-hidden="true" className="setup-step-number">{index < stepIndex ? '✓' : number.format(index + 1)}</span>
          <span>{label}<small>{index < stepIndex ? 'ذخیره شد' : index === stepIndex ? 'مرحلهٔ فعلی' : ''}</small></span>
        </li>)}
      </ol>
    </aside>
    <section className="setup-card edu-card" aria-labelledby="setup-step-title" aria-busy={pending}>
      <header className="setup-card-top">
        {completed ? <span className="setup-counter setup-complete">تکمیل شد</span> :
          <span className="setup-counter">مرحلهٔ {number.format(stepIndex + 1)} از ۴</span>}
        <h2 id="setup-step-title" tabIndex={-1} ref={heading}>
          {completed ? (demo ? 'تمرین راه‌اندازی کامل شد' : 'راه‌اندازی اولیه کامل شد') : stepLabels[stepIndex]}
        </h2>
      </header>
      <div className="setup-card-content">
        {completed ? <>
          <dl className="setup-summary">
            <div><dt>{organizationTitle(state.draft.organization?.kind) ?? 'مجموعه'}</dt>
              <dd>{state.draft.organization?.name}</dd></div>
            <div><dt>مدرسه</dt><dd>{state.draft.school?.name}</dd></div>
            <div><dt>دعوت مدیر</dt><dd>{demo ? 'شبیه‌سازی شد' :
              state.draft.invitation?.status === 'queued' ? 'در صف ارسال' : 'در سامانه ثبت شد'}</dd></div>
            <div><dt>نخستین سایت</dt><dd>{state.draft.site?.name}</dd>
              <dd className="setup-hint">{demo ? 'نشانی نمونه' : 'پیش‌نویس ثبت‌شده'} <bdi>{state.draft.site?.slug}</bdi></dd></div>
          </dl>
          {reset && <button className="setup-button setup-secondary" type="button" onClick={reset}>شروع دوبارهٔ تمرین</button>}
        </> : <form onSubmit={submit}>
          <fieldset className="setup-fields" disabled={pending}>
            <legend className="setup-visually-hidden">{stepLabels[stepIndex]}</legend>
            <StepFields state={state} demo={demo} key={state.step} />
          </fieldset>
          {error && <p className="edu-error setup-feedback" role="alert">{error}</p>}
          {notice && <p className="setup-note setup-feedback" role="status">{notice}</p>}
          <div className="setup-actions">
            <button className="setup-button setup-primary" disabled={pending} type="submit">
              {pending ? 'در حال ذخیره…' : demo ? 'ذخیره و ادامهٔ تمرین' : 'ذخیره و ادامه'}
            </button>
            {error && reload && <button className="setup-button setup-secondary" type="button" disabled={pending}
              onClick={() => void refresh()}>دریافت دوبارهٔ وضعیت</button>}
          </div>
        </form>}
        {completed && notice && <p className="setup-note setup-feedback" role="status">{notice}</p>}
      </div>
    </section>
  </div>;
}

function DemoWorkspace({ school }: { school: DemoSchool }) {
  const [state, setState] = useState(() => restoreDemo(storagePort, school));
  const [notice, setNotice] = useState<string>();
  return <Workspace state={state} demo={school} notice={notice}
    advance={async (current, next) => {
      const updated = readOnboardingState(advanceDemo(current, next));
      if (!updated) throw new GatewayRequestError(422);
      const saved = persistDemo(storagePort, school, updated);
      setNotice(saved ? undefined : 'ذخیره در این مرورگر در دسترس نیست. پیشرفت تا زمان بستن صفحه باقی می‌ماند.');
      setState(updated);
    }}
    reset={() => {
      const cleared = clearDemo(storagePort, school);
      setNotice(cleared ? undefined : 'پاک کردن پیشرفت از حافظهٔ مرورگر ممکن نشد.');
      setState(initialState());
    }}
  />;
}

function LiveWorkspace({ client }: { client: OnboardingClient }) {
  const [session, setSession] = useState<Session>();
  const [state, setState] = useState<OnboardingState>();
  const activeSession = useRef<Session>(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const input = new FormData(form);
    const password = form.elements.namedItem('password');
    if (password instanceof HTMLInputElement) password.value = '';
    setPending(true);
    setError(undefined);
    try {
      const authenticated = await client.login({
        login: readText(input, 'login'), tenantId: readText(input, 'tenantId').toLowerCase(),
        password: String(input.get('password') ?? ''),
      });
      const draft = await client.read(authenticated);
      activeSession.current = authenticated;
      setSession(authenticated);
      setState(draft);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  if (!session || !state) {
    return <section className="setup-card edu-card setup-login" aria-labelledby="setup-login-title" aria-busy={pending}>
      <header className="setup-card-top"><h2 id="setup-login-title">ورود به راه‌اندازی</h2></header>
      <form className="setup-card-content" onSubmit={login}>
        <fieldset className="setup-fields" disabled={pending}>
          <legend className="setup-visually-hidden">مشخصات ورود</legend>
          <Field label="ایمیل حساب" name="login" type="email" dir="ltr" maxLength={254} autoComplete="username" />
          <Field label="رمز عبور" name="password" type="password" dir="ltr" maxLength={1024} autoComplete="current-password" />
          <Field label="شناسهٔ مجموعه" name="tenantId" dir="ltr" maxLength={36} pattern={uuidPattern}
            autoComplete="off" spellCheck={false} />
        </fieldset>
        {error && <p role="alert" className="edu-error setup-feedback">{error}</p>}
        <div className="setup-actions"><button className="setup-button setup-primary" disabled={pending} type="submit">
          {pending ? 'در حال ورود…' : 'ورود و بازیابی پیشرفت'}
        </button></div>
      </form>
    </section>;
  }

  return <>
    <div className="setup-session">
      <button className="setup-button setup-secondary" type="button" onClick={() => {
        activeSession.current = undefined;
        setSession(undefined);
        setState(undefined);
        void client.logout(session).catch(() => {});
      }}>خروج از حساب</button>
    </div>
    <Workspace key={session.tenantId} state={state}
      advance={async (current, next, code) => {
        if (next.step === 'invitation') await client.verifyInvitation(session, code);
        if (activeSession.current !== session) return;
        const updated = await client.advance(session, current.version, next);
        if (activeSession.current === session) setState(updated);
      }}
      reload={async () => {
        const updated = await client.read(session);
        if (activeSession.current === session) setState(updated);
      }}
    />
  </>;
}

export function Onboarding({ configuredApi, schoolQuery }: { configuredApi?: string; schoolQuery: string | string[] | undefined }) {
  const demo = configuredApi === undefined;
  const school = schoolQuery === undefined ? 'aftab' :
    typeof schoolQuery === 'string' && Object.hasOwn(demoSchools, schoolQuery) ? schoolQuery as DemoSchool : null;
  let client;
  if (configuredApi !== undefined) {
    try { client = createOnboardingClient(configuredApi); } catch { client = null; }
  }

  return <main id="main" tabIndex={-1} className="edu-frame setup-main">
    <section className="setup-intro" aria-labelledby="page-title">
      <p className="setup-section-label">{demo ? 'پیش‌نمایش آموزشی' : 'پنل مدیریت EduApp'}</p>
      <h1 id="page-title">راه‌اندازی مجموعه و مدرسه</h1>
      <p>{demo ? 'با دادهٔ فرضی مسیر ساخت مجموعه، مدرسه و نخستین سایت را تمرین کنید.' :
        'مشخصات مجموعه را ثبت کنید و راه‌اندازی مدرسه، مدیر و سایت را مرحله‌به‌مرحله ادامه دهید.'}</p>
    </section>
    {demo ? <>
      <div className="setup-demo-strip">
        <p>این پیش‌نمایش در همین مرورگر ذخیره می‌شود و دعوت یا سایت واقعی ایجاد نمی‌کند.</p>
        <nav className="edu-school-links" aria-label="مدرسهٔ تمرینی">
          {Object.entries(demoSchools).map(([id, option]) => <a key={id} href={'?view=onboarding&school=' + id}
            aria-current={school === id ? 'true' : undefined}>{option.label}</a>)}
        </nav>
      </div>
      {school ? <DemoWorkspace key={school} school={school} /> :
        <p className="edu-error" role="status">مدرسهٔ نمونه را از بالا انتخاب کنید.</p>}
    </> : client ? <LiveWorkspace client={client} /> :
      <p className="edu-error" role="alert">نشانی سرویس راه‌اندازی معتبر نیست.</p>}
  </main>;
}
