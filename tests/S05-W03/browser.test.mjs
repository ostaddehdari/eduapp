import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const localhost = '127.0.0.1';
test('visitor selects a published version, modules and seats before payment', { timeout: 30_000 }, async t => {
  const probe = createServer();
  probe.listen(0, localhost); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const web = spawn(process.execPath, ['apps/public-web/.output/server/index.mjs'], {
    cwd: new URL('../../', import.meta.url), stdio: 'ignore',
    env: { ...process.env, NITRO_HOST: localhost, NITRO_PORT: String(port) },
  });
  t.after(async () => { if (web.exitCode === null && web.signalCode === null) { web.kill(); await once(web, 'exit'); } });
  const url = `http://${localhost}:${port}`;
  let ready = false;
  for (let n = 0; n < 50; n++) {
    try { const response = await fetch(url); await response.body?.cancel(); if (response.ok) { ready = true; break; } }
    catch { /* startup */ }
    await delay(100);
  }
  assert(ready, 'Nuxt build must respond');
  const browser = await chromium.launch({ executablePath: process.env.EDUAPP_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route('**/eduapp/api/v1/plans?limit=100', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{
      id: '11111111-1111-4111-8111-111111111111', code: 'school_plus', version: 2,
      priceMinor: '100000', currency: 'IRR', modules: ['school', 'attendance'],
      quotas: { seats: 30 }, trialDays: 14, termDays: 365,
    }] }),
  }));
  await page.goto(url);
  await page.getByRole('heading', { name: 'خلاصه پیش از پرداخت' }).waitFor();
  await page.getByLabel(/تعداد صندلی/).fill('12');
  await page.getByLabel('attendance').uncheck();
  const summary = await page.locator('.edu-summary').innerText();
  assert.match(summary, /۱۰۰٬۰۰۰ ریال/);
  assert.match(summary, /سرویس صورتحساب EduApp/);
  assert.match(summary, /مدت قرارداد/);
  assert.match(summary, /۱۲/);
  assert.match(summary, /پرداخت در این مرحله فعال نیست/);
  assert.equal(await page.getByRole('button', { name: /پرداخت/ }).count(), 0);
  await page.getByLabel(/تعداد صندلی/).fill('31');
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /اصلاح کنید/);
  await page.route('**/eduapp/api/v1/plans?limit=100', route => route.fulfill({ status: 503 }));
  await page.reload();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /قیمت‌ها فعلاً در دسترس نیستند/);
  assert.equal(await page.locator('.edu-summary').count(), 0);
});
