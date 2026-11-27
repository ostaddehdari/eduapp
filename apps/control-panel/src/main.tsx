import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@eduapp/ui-tokens/theme.css';
import { formatPersianTimestamp, readSchoolPreview, schoolOptions } from '@eduapp/ui-tokens/preview';
import { welcomeTitle } from './app-model';
import { Onboarding } from './onboarding';
import { Management } from './management';

const root = document.getElementById('root');
if (!root) throw new Error('ROOT_ELEMENT_MISSING');
const query = new URLSearchParams(window.location.search);
const choices = query.getAll('school');
const schoolQuery = choices.length > 1 ? choices : choices[0];
const school = readSchoolPreview(schoolQuery);
const showOnboarding = query.get('view') === 'onboarding';
const showManagement = query.get('view') === 'management';
const changed = formatPersianTimestamp(school?.updatedAt);

createRoot(root).render(
  <StrictMode>
    <a className="edu-skip" href="#main">رفتن به محتوای اصلی</a>
    <header className="edu-header">
      <div className="edu-frame edu-bar">
        <a className="edu-brand" href="./" lang="en" dir="ltr">EduApp</a>
        <nav className="edu-nav" aria-label="ناوبری پنل">
          <a href={showOnboarding || showManagement ? './' : '#school-preview'}>نمای کلی</a>
          <a href="?view=onboarding" aria-current={showOnboarding ? 'page' : undefined}>راه‌اندازی مدرسه</a>
          <a href="?view=management" aria-current={showManagement ? 'page' : undefined}>مدیریت مجموعه</a>
        </nav>
      </div>
    </header>
    {showManagement ? <Management configuredApi={import.meta.env.VITE_EDUAPP_API_BASE} sample={query.get('sample') ?? ''} /> :
    showOnboarding ? <Onboarding configuredApi={import.meta.env.VITE_EDUAPP_API_BASE} schoolQuery={schoolQuery} /> :
    <main id="main" className="edu-frame edu-shell edu-shell--panel" tabIndex={-1}>
      <section className="edu-intro" aria-labelledby="page-title">
        <p className="edu-context">پنل مدیریت EduApp</p>
        <h1 id="page-title" className="edu-heading">{school ? welcomeTitle(school.name) : 'پنل مدیریت مدرسه'}</h1>
        <p className="edu-description">مدرسهٔ نمونه را انتخاب کنید تا اطلاعات همان مدرسه را در نمای کلی ببینید.</p>
      </section>
      <section id="school-preview" className="edu-card" aria-labelledby="preview-title">
        <div className="edu-card-head">
          <h2 id="preview-title">نمای کلی مدرسه</h2>
          <nav className="edu-school-links" aria-label="انتخاب مدرسهٔ نمونه">
            {schoolOptions.map((option) => (
              <a
                key={option.id}
                href={'?school=' + option.id}
                aria-current={school?.id === option.id ? 'true' : undefined}
              >{option.name}</a>
            ))}
          </nav>
        </div>
        <div className="edu-card-body">
          {school ? (
            <>
              <dl className="edu-record">
                <div><dt>مدرسه</dt><dd>{school.name}</dd></div>
                <div><dt>آخرین به‌روزرسانی</dt><dd>{changed ? (
                  <time dateTime={school.updatedAt}>{changed}</time>
                ) : 'در دسترس نیست'}</dd></div>
              </dl>
              <details className="edu-details">
                <summary>جزئیات نمایش</summary>
                <p>این اطلاعات نمونه است. زمان به تاریخ شمسی و ساعت ایران نمایش داده می‌شود.</p>
              </details>
            </>
          ) : (
            <p className="edu-error" role="status">این مدرسه در پیش‌نمایش پیدا نشد. یکی از مدارس نمونه را انتخاب کنید.</p>
          )}
        </div>
      </section>
    </main>}
  </StrictMode>,
);
