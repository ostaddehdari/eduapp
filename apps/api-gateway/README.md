# اجرای Gateway نسخهٔ ۱

ورودی محلی با Node پروژه اجرا می‌شود.

```bash
node apps/api-gateway/src/main.mjs
curl http://127.0.0.1:3010/v1/health/live
```

نسخهٔ اجرایی فعلی سه مسیر `GET /v1/health/live`، `GET /v1/health/ready` و `GET /v1/version` دارد. فایل OpenAPI اجرایی `packages/contracts/openapi/gateway-active-v1.json` مبنای SDK است. برنامهٔ Node فقط روی loopback گوش می‌دهد. پورت با `GATEWAY_PORT` تنظیم می‌شود.

مالک یک عملیات می‌تواند با operationId کاتالوگ، نرخ، queryهای مجاز و تابع اجرا را به `createGateway` بدهد. عملیات محفوظ به تابع احراز نشست و مجوز مالک نیاز دارد. عملیات idempotent به آداپتور مالک برای ثبت اتمی نتیجه، کنترل fingerprint و بازپخش نیاز دارد. تست‌ها نحوهٔ اتصال آداپتورها را با دادهٔ مصنوعی نشان می‌دهند. شمارندهٔ پیش‌فرض و cursor store برای اجرای تک‌فرایندی محلی‌اند. استقرار چندنمونه‌ای به ذخیره‌ساز مشترک تأییدشده نیاز دارد.

SDK فعلی تایپ و متدهای سه مسیر اجرایی را ارائه می‌کند. مولد و diff در خود مخزن نسخه‌گذاری شده‌اند. تغییرات کاتالوگ و قرارداد اجرایی در CI با آخرین نسخهٔ شاخهٔ مقصد مقایسه می‌شوند. افزودن مسیر اجرایی و SDK برای عملیات دامنه باید همزمان با اتصال سرویس مالک و تکمیل قرارداد ورودی و خروجی انجام شود.

```bash
node scripts/gateway-contract.mjs generate
node scripts/gateway-contract.mjs check
node --test apps/api-gateway/test/*.test.mjs
```

[راهنمای آزمون جداسازی دو مستأجر و خطاهای Gateway](../../tests/S02-W02/README.md)
