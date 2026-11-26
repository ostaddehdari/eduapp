import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@eduapp/ui-tokens/theme.css';
import { formatPersianTimestamp, readSchoolPreview, schoolOptions } from '@eduapp/ui-tokens/preview';
import { welcomeTitle } from './app-model';

const root = document.getElementById('root');
if (!root) throw new Error('ROOT_ELEMENT_MISSING');
const choices = new URLSearchParams(window.location.search).getAll('school');
const school = readSchoolPreview(choices.length > 1 ? choices : choices[0]);
const changed = formatPersianTimestamp(school?.updatedAt);

createRoot(root).render(
  <StrictMode>
    <a className="edu-skip" href="#main">رفتن به محتوای اصلی</a>
    <header className="edu-header">
      <div className="edu-frame edu-bar">
        <a className="edu-brand" href="/" lang="en" dir="ltr">EduApp</a>
        <nav className="edu-nav" aria-label="ناوبری پنل">
          <a href="#school-preview">نمای کلی</a>
        </nav>
      </div>
    </header>
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
    </main>
  </StrictMode>,
);
