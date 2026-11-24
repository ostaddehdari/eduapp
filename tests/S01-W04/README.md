# S01-W04 boundary tests

این بسته، قرارداد حکمرانی `S01-W04` و مدل عملیاتی `S01-W04-T02` را بدون اتصال به Provider یا production آزمایش می‌کند.

## اجرا

```bash
node --test tests/S01-W04/provider-approval.boundary.test.mjs
```

برای اجرای زنجیره کامل:

```bash
node scripts/validate-provider-governance-contract.mjs
node scripts/validate-provider-approval-workflow.mjs
node --test tests/S01-W04/provider-approval.boundary.test.mjs
```

## پوشش

- جلوگیری از ثبت evidence پرونده Tenant اول توسط Tenant دوم
- evidence ناقص، منقضی یا شامل PII/Secret خام
- actor تکراری، approval ناقص یا متصل به manifest قدیمی
- قرارداد، بودجه، POC، محل پردازش و Secret reference ناقص
- منع بیومتریک خام برای دستگاه حضور
- منع write در اتصال مالی مدرسه
- scope رابطه سرپرست و رضایت
- توقف مسیر موفق مصنوعی در `activation_requested` تا production change مستقل

تمام داده‌ها ساختگی‌اند. این تست Provider، Secret، دیتابیس، Nginx یا production را تغییر نمی‌دهد.
