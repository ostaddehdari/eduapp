# ADR-0002 — توپولوژی آغازین runtime و فرایند split

- وضعیت: پذیرفته‌شده
- نسخه: `1.0.0`
- تاریخ تصویب: `2026-11-23`
- مالک تصمیم: Platform Architecture
- الزام مرتبط: `DATA-001`
- قرارداد مرجع: `docs/contracts/S01-W03.json` نسخه `1.0.0`

## مسئله

ده bounded context منطقی برای مالکیت داده و قرارداد تعریف شده‌اند، اما تبدیل هر context به سرویس مستقل در شروع، شبکه، secret، CI/CD، observability، migration و on-call جداگانه می‌خواهد و بدون داده بار یا تیم مستقل، ریسک عملیاتی را افزایش می‌دهد. در عین حال یک monolith بدون مرز نیز مالکیت داده و امکان جداسازی آینده را از بین می‌برد.

## تصمیم

1. شروع با modular monolith دارای ده مرز صریح انجام می‌شود.
2. واحدهای استقرار نسخه اول `api`، `worker`، `public-web` و `control-panel` هستند.
3. PostgreSQL منبع حقیقت است؛ هر context schema/repository مالک دارد و نوشتن مستقیم بین contextها ممنوع است.
4. ارتباط همگام از application service/API نسخه‌دار و ارتباط ناهمگام از outbox، event نسخه‌دار و inbox dedupe عبور می‌کند.
5. Redis تا نیاز اندازه‌گیری‌شده و RabbitMQ تا POC معتبر deferred هستند؛ broker جایگزین outbox نمی‌شود.
6. split با ترجیح فنی یا نام context انجام نمی‌شود. شاهدهای اجباری قرارداد، migration و هزینه به‌علاوه حداقل یک محرک تیم/بار/SLO لازم است.
7. تکمیل gateها فقط درخواست را eligible for reviewed ADR می‌کند؛ اجرای split یک تغییر مستقل با تست، rollout و rollback جداست.

## پیامدهای مثبت

- مالکیت داده و قرارداد از روز اول روشن و قابل آزمون است.
- تعداد اجزای production در شروع محدود می‌ماند.
- استخراج سرویس آینده با قرارداد و telemetry واقعی تصمیم‌گیری می‌شود.
- رخداد تکراری و command مالی replay-safe طراحی می‌شوند.

## هزینه‌ها و محدودیت‌ها

- تیم باید lint/validator مرزها را جدی بگیرد؛ هم‌فرایندی مجوز دورزدن مرز نیست.
- failure isolation کامل سرویس مستقل فعلاً وجود ندارد.
- migration مالکیت داده تا ADR و برنامه reconciliation مجاز نیست.

## شرایط بازنگری

این تصمیم زمانی بازنگری می‌شود که حداقل یکی از موارد زیر با شاهد ثبت شود: تیم و on-call مستقل، ۳۰ روز فشار اندازه‌گیری‌شده، یا SLO/نیاز امنیتی مستقل. در همه حالات contract readiness، data migration readiness و cost review الزامی‌اند.

## Rollback

این ADR داده یا runtime را تغییر نمی‌دهد. rollback با Git revert انجام می‌شود. هر split آینده rollback و restore drill مستقل خود را خواهد داشت.
