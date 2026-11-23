# مدل عملیاتی مرز سرویس و استقرار

- شناسه تسک: `S01-W03-T02`
- نسخه: `1.0.0`
- وضعیت: پذیرفته‌شده
- الزام: `DATA-001`
- قرارداد مرجع: [`../contracts/S01-W03.json`](../contracts/S01-W03.json)
- مدل ماشین‌خوان: [`service-boundary-operating-model.v1.json`](service-boundary-operating-model.v1.json)
- تصمیم معماری: [`ADR-0002`](../decisions/ADR-0002-initial-runtime-topology-and-split-process.md)

## هدف این سند

قرارداد `S01-W03` می‌گوید هر داده، API و رویداد متعلق به کدام context است. این سند آن قرارداد را به مسیر اجرایی قابل بازبینی تبدیل می‌کند: درخواست از کجا وارد می‌شود، چه کسی مجوز نهایی می‌دهد، تراکنش کجا بسته می‌شود، رویداد چگونه بدون اثر تکراری تحویل می‌شود، migration چگونه محدود می‌ماند و چه زمانی درخواست split اصلاً اجازه بررسی پیدا می‌کند.

این مرحله سرویس جدید، دیتابیس جدید یا تغییر production ایجاد نمی‌کند. چهار واحد استقرار آغازین همان `api`، `worker`، `public-web` و `control-panel` هستند و PostgreSQL منبع حقیقت باقی می‌ماند.

## مسیر فرمان همگام

1. Gateway فقط احراز اولیه، rate limit، request ID و route را انجام می‌دهد.
2. Tenant از عضویت فعال مشتق می‌شود؛ `tenant_id` ارسال‌شده از کلاینت منبع اعتماد نیست.
3. context مالک، مجوز نهایی command را در application service خود بررسی می‌کند.
4. repository فقط schema و جدول‌های مالک را می‌نویسد؛ SQL و ORM مشترک بین contextها ممنوع است.
5. aggregate و outbox لازم در یک تراکنش commit می‌شوند.
6. خطای مرز مالکیت با `FOREIGN_DATA_OWNER` و خطای context با `TENANT_CONTEXT_MISMATCH` fail-closed است.

## مسیر رویداد و worker

1. worker رکورد outbox را claim می‌کند و event نسخه‌دار را منتشر می‌کند.
2. consumer ابتدا `(consumer,event_id)` را در inbox ثبت می‌کند.
3. اجرای تکراری با acknowledgement بدون side effect پایان می‌یابد.
4. consumer فقط application service context مالک خودش را فراخوانی می‌کند و از payload برای مجوز کاربر استفاده نمی‌کند.
5. Redis و RabbitMQ هنوز dependency اجباری نیستند؛ افزودن broker، outbox را حذف نمی‌کند.

## مسیر Tenant و connection pool

پیش از bind شدن Tenant جدید، context اتصال reset می‌شود. عضویت فعال بررسی، Tenant bind و پس از query پاک می‌شود. اتصال بدون context یا context متعلق به Tenant دیگر اجازه query دامنه‌ای ندارد. آزمون دو Tenant و pool reuse در `S01-W03-T03` اجرا می‌شود.

## مسیر migration

Migration باید مالک schema، اثر API/event و rollback را اعلام کند. الگوی پیش‌فرض `expand → migrate/reconcile → switch → contract` است. migration بین دو مالک در یک تغییر رد می‌شود. پیش از production، backup/restore در staging و health/reconciliation باید سبز باشند.

## مسیر تصمیم split

حالت پیش‌فرض «ماندن در modular monolith» است. برای ورود درخواست به بازبینی، سه شاهد `contract_readiness`، `data_migration_readiness` و `cost_review` همیشه لازم‌اند و حداقل یکی از `independent_team`، `measured_pressure` یا `independent_slo_or_security` نیز باید موجود باشد.

حتی تکمیل شاهدها split را اجرا نمی‌کند؛ فقط اجازه ADR بازبینی‌شده می‌دهد. ADR باید مالک تیم/on-call، SLO، قرارداد سازگار، شبکه و secret، observability، migration/reconciliation، rollback/restore و هزینه CI/CD را تصویب کند. فقدان شاهد با `SPLIT_EVIDENCE_INCOMPLETE` رد می‌شود.

## جدول مسئولیت اجرایی

| مسئول | مجاز | ممنوع |
|---|---|---|
| API Gateway | احراز اولیه، rate limit، route | DB write و مجوز نهایی دامنه |
| Context owner | command/query مالک، schema مالک، event نسخه‌دار | جدول context دیگر |
| Worker | outbox، inbox dedupe و application service مالک | cross-context SQL و مجوز از payload |
| Migration runner | migration بازبینی‌شده همان مالک | runtime و migration چندمالک |
| Web clients | HTTP نسخه‌دار | DB یا event داخلی |

## کنترل تغییر و بازگشت

- تغییر breaking در API یا event نیازمند version bump و consumer review است.
- انتقال مالکیت داده نیازمند major contract version، ADR، migration مرحله‌ای، reconciliation و restore drill است.
- هر انتشار باید source SHA تغییرناپذیر، health check، لاگ پاکسازی‌شده و rollback target داشته باشد.
- rollback این تسک فقط Git revert است؛ هیچ migration یا تغییر سرور در این تسک انجام نشده است.
