# CI و اجرای محلی EduApp

با Node درج‌شده در `.nvmrc` و Corepack، وابستگی‌ها را با `corepack pnpm install --frozen-lockfile --ignore-scripts` نصب کنید. فرمان‌های `corepack pnpm lint`، `corepack pnpm typecheck`، `corepack pnpm test` و `corepack pnpm build` برای کل workspace اجرا می‌شوند.

- API با `corepack pnpm --filter @eduapp/api start` بعد از build در مسیر محلی `/api/health` پاسخ می‌دهد.
- Worker با `corepack pnpm --filter @eduapp/worker start` آماده‌سازی NestJS را بررسی می‌کند.
- وب و پنل با `corepack pnpm --filter @eduapp/public-web dev` و `corepack pnpm --filter @eduapp/control-panel dev` اجرا می‌شوند.

فایل `main-protection.json` تنظیمات مورد انتظار شاخه را نگه می‌دارد. محافظت `main` در GitHub فعال است و هر شش چک برای ادغام الزامی‌اند. در حالت تک‌مالک، PR و وضعیت سبز چک‌ها اجباری‌اند و حداقل تعداد تأیید مستقل صفر است.

راهنمای اجرا و دامنهٔ [آزمون‌های مرزی](../../tests/S02-W01/README.md) در مسیر تست‌ها ثبت شده است.
