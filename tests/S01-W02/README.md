# S01-W02 — شواهد آزمون مرزی سفر تجاری

این پوشه معیار پذیرش `S01-W02-T03` را با یک harness قطعی و بدون وابستگی شبکه آزمایش می‌کند. Harness رفتار قرارداد و PRD را شبیه‌سازی می‌کند و ادعای وجود Backend production نیست.

## اجرا

```bash
node --test tests/S01-W02/commercial-journey.boundary.test.mjs
node scripts/validate-commercial-journey-contract.mjs
node scripts/validate-commercial-journey-prd.mjs
```

## پوشش

1. پرداخت تأییدشده و مدرسه مستقل.
2. مجموعه، شعبه و مدرسه هم‌Tenant.
3. پنج replay پرداخت و فقط یک provider event، ledger، entitlement، subscription و Tenant.
4. callback تأییدنشده و صفر اثر جانبی.
5. Tenant دوم و رد parent و org unit خارجی بدون تغییر state.
6. رد چرخه و کد sibling تکراری با حفظ نسخه درخت.

## انتظار

- `6/6` تست Node سبز باشد.
- validator قرارداد و PRD هر دو exit code صفر بدهند.
- داده تست ساختگی است؛ token، کلید درگاه، PII یا داده کودک استفاده نمی‌شود.

## Runbook خطا و بازگشت

1. در شکست تست، هیچ deployment یا migration اجرا نشود و نام تست و کد خطای مورد انتظار ثبت شود.
2. اگر قرارداد/PRD تغییر کرده، ابتدا اختلاف version و scenario ID بررسی و سپس harness در PR بازبینی‌شده هماهنگ شود؛ انتظار تست برای سبزشدن مصنوعی ضعیف نشود.
3. بازگشت این Task فقط با Git revert فایل‌های همین پوشه انجام می‌شود. این Task داده runtime ندارد و rollback سرور، Nginx یا دیتابیس لازم نیست.
