# شواهد آزمون مرزی S01-W03

این بسته قرارداد و مدل عملیاتی `S01-W03` را با یک harness مستقل و بدون اتصال به production آزمایش می‌کند.

سناریوهای پوشش‌داده‌شده:

1. پوشش هر ۱۰ bounded context و هر ۱۲ مالک داده در مدل عملیاتی.
2. bind متوالی Tenant A و Tenant B روی اتصال بازاستفاده‌شده، بدون مشاهده داده Tenant قبلی.
3. شکست عضویت Tenant C با `TENANT_CONTEXT_MISMATCH` و پاک ماندن connection context.
4. رد نوشتن مستقیم در context بیگانه با `FOREIGN_DATA_OWNER` و بدون تغییر state.
5. پنج replay فرمان مالی با یک ledger و یک outbox event؛ payload متفاوت با همان key رد می‌شود.
6. پنج تحویل event با یک inbox record و یک side effect.
7. رد split ناقص با `SPLIT_EVIDENCE_INCOMPLETE`؛ شواهد کامل فقط اجازه ADR review می‌دهد و split خودکار نمی‌کند.

اجرا:

```bash
node --test tests/S01-W03/service-boundary.boundary.test.mjs
node scripts/validate-service-boundary-contract.mjs
node scripts/validate-service-boundary-operating-model.mjs
```

این آزمون‌ها هیچ migration، شبکه، Nginx، فایل کاربر یا داده production را تغییر نمی‌دهند.
