import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const app = fileURLToPath(new URL('../../apps/control-panel/', import.meta.url));
const base = '/eduapp/panel/';
const api = '/eduapp/api';
const types = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'], ['.woff2', 'font/woff2'],
]);

async function startPanel(t, serveApi) {
  const output = await mkdtemp(join(tmpdir(), 'eduapp-onboarding-browser-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.VITE_EDUAPP_API_BASE;
  if (serveApi) env.VITE_EDUAPP_API_BASE = api;
  const build = spawnSync(process.execPath, [
    join(app, 'node_modules/vite/bin/vite.js'), 'build', '--base=./', '--outDir', output,
  ], { cwd: app, env, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname.startsWith(api + '/v1/') && serveApi) {
      try {
        await serveApi(pathname.slice(api.length + 3), req, res);
      } catch {
        res.writeHead(500).end();
      }
      return;
    }
    const file = pathname === base ? 'index.html' : pathname.slice(base.length);
    if (!pathname.startsWith(base) || (file !== 'index.html' && !/^assets\/[A-Za-z0-9._-]+$/.test(file))) {
      res.writeHead(404).end();
      return;
    }
    try {
      res.writeHead(200, { 'Content-Type': types.get(extname(file)) }).end(await readFile(join(output, file)));
    } catch {
      res.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return 'http://127.0.0.1:' + server.address().port + base;
}

const launch = () => chromium.launch({ executablePath: process.env.EDUAPP_CHROMIUM_EXECUTABLE });

test('static wizard resumes each sample school separately and sends no API calls', { timeout: 45_000 }, async t => {
  const url = await startPanel(t);
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 790 } });
  const requests = [];
  const errors = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByRole('link', { name: 'راه‌اندازی مدرسه' }).click();
  await page.getByRole('heading', { name: 'مشخصات مجموعه', exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
  assert(await page.getByText('این پیش‌نمایش در همین مرورگر').isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const submit = () => page.getByRole('button', { name: 'ذخیره و ادامهٔ تمرین' }).click();
  const organizationName = 'مجموعهٔ فرضی بازگشت';
  await page.getByLabel('نام مجموعه', { exact: true }).fill(organizationName);
  await submit();
  await page.getByRole('heading', { name: 'تعریف مدرسه' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'setup-step-title');

  await page.reload();
  await page.getByRole('heading', { name: 'تعریف مدرسه' }).waitFor();
  await page.getByRole('link', { name: 'مدرسهٔ باران' }).click();
  await page.getByRole('heading', { name: 'مشخصات مجموعه' }).waitFor();
  assert.equal(await page.getByLabel('نام مجموعه').inputValue(), 'مجموعهٔ آموزشی باران');
  await page.getByRole('link', { name: 'مدرسهٔ آفتاب' }).click();
  await page.getByRole('heading', { name: 'تعریف مدرسه' }).waitFor();
  await page.getByLabel('ساختار مدرسه').selectOption('branch');
  assert(await page.getByLabel('نام نخستین شعبه').isVisible());
  await submit();
  await page.getByRole('heading', { name: 'دعوت مدیر' }).waitFor();
  assert(await page.getByText('این مرحله فقط ثبت دعوت را شبیه‌سازی می‌کند.').isVisible());
  assert.equal(await page.getByLabel('شناسهٔ کاربری مدیر').count(), 0);
  await submit();
  await page.getByRole('heading', { name: 'نخستین سایت' }).waitFor();
  await submit();
  await page.getByRole('heading', { name: 'تمرین راه‌اندازی کامل شد' }).waitFor();
  assert(await page.getByText(organizationName).isVisible());
  assert(await page.getByText('شبیه‌سازی شد', { exact: true }).isVisible());
  assert(await page.getByText('نشانی نمونه', { exact: false }).isVisible());
  await page.getByRole('button', { name: 'شروع دوبارهٔ تمرین' }).click();
  await page.getByRole('heading', { name: 'مشخصات مجموعه' }).waitFor();
  assert.equal(requests.filter(path => path.startsWith(api)).length, 0);
  assert.deepEqual(errors, []);
});

test('configured wizard uses same-origin Gateway, memory-only sessions and verified resume', { timeout: 45_000 }, async t => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const manager = randomUUID();
  const receipts = new Map();
  const requests = [];
  const verified = new Set();
  async function fixture(path, req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const token = req.headers.authorization;
    requests.push({ path, token, input });
    const reply = (status, data) => {
      if (status === 204) return res.writeHead(status).end();
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
    };
    if (path === '/auth/login') {
      if (input.login !== 'fixture@example.test' || input.password !== 'only-a-fixture' ||
        ![tenantA, tenantB].includes(input.tenantId)) return reply(401);
      return reply(200, { accessToken: input.tenantId, tenantId: input.tenantId });
    }
    const tenantId = token?.slice(7);
    if (![tenantA, tenantB].includes(tenantId)) return reply(401);
    const current = receipts.get(tenantId) ?? { version: 0, step: 'organization', draft: {} };
    if (path === '/onboarding') return reply(200, current);
    if (path === '/auth/logout') { verified.delete(tenantId); return reply(204); }
    if (path === '/auth/mfa/step-up') {
      if (input.code !== '123456') return reply(401);
      verified.add(tenantId);
      return reply(200, { verified: true });
    }
    if (path !== '/onboarding/advance') return reply(404);
    if (input.expectedVersion !== current.version || input.step !== current.step) return reply(409);
    if (input.step === 'invitation' && (!verified.has(tenantId) || input.input.identityId !== manager)) return reply(403);
    const order = ['organization', 'school', 'invitation', 'site', 'completed'];
    const draft = { ...current.draft, [input.step]: { ...input.input } };
    if (input.step === 'invitation') draft.invitation.status = 'queued';
    if (input.step === 'site') draft.site.status = 'draft';
    const advanced = { version: current.version + 1, step: order[order.indexOf(current.step) + 1], draft };
    receipts.set(tenantId, advanced);
    return reply(200, advanced);
  }

  const url = await startPanel(t, fixture);
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(url + '?view=onboarding&school=aftab');
  const login = async tenantId => {
    await page.getByLabel('ایمیل حساب').fill('fixture@example.test');
    await page.getByLabel('رمز عبور').fill('only-a-fixture');
    await page.getByLabel('شناسهٔ مجموعه').fill(tenantId);
    await page.getByRole('button', { name: 'ورود و بازیابی پیشرفت' }).click();
  };
  const submit = () => page.getByRole('button', { name: 'ذخیره و ادامه', exact: true }).click();
  await login(tenantA);
  await page.getByRole('heading', { name: 'مشخصات مجموعه' }).waitFor();
  await page.getByLabel('نام مجموعه').fill('مجموعهٔ فرضی نخست');
  await page.getByLabel('کد مجموعه').fill('fixture-group');
  await submit();
  await page.getByRole('heading', { name: 'تعریف مدرسه' }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'ورود به راه‌اندازی' }).waitFor();
  await login(tenantB);
  await page.getByRole('heading', { name: 'مشخصات مجموعه' }).waitFor();
  assert.equal(await page.getByLabel('نام مجموعه').inputValue(), '');
  await page.getByRole('button', { name: 'خروج از حساب' }).click();
  await login(tenantA);
  await page.getByRole('heading', { name: 'تعریف مدرسه' }).waitFor();
  await page.getByLabel('نام مدرسه').fill('مدرسهٔ فرضی نخست');
  await page.getByLabel('کد مدرسه').fill('fixture-school');
  await submit();
  await page.getByRole('heading', { name: 'دعوت مدیر' }).waitFor();
  await page.getByLabel('شناسهٔ کاربری مدیر').fill(manager);
  await page.getByLabel('کد تأیید دومرحله‌ای').fill('۰۰۰۰۰۰');
  await submit();
  await page.getByRole('alert').waitFor();
  assert.equal(receipts.get(tenantA).step, 'invitation');
  await page.getByLabel('کد تأیید دومرحله‌ای').fill('۱۲۳۴۵۶');
  await submit();
  await page.getByRole('heading', { name: 'نخستین سایت' }).waitFor();
  await submit();
  await page.getByRole('heading', { name: 'راه‌اندازی اولیه کامل شد' }).waitFor();
  assert(await page.getByText('در صف ارسال', { exact: true }).isVisible());
  assert(await page.getByText('پیش‌نویس ثبت‌شده', { exact: false }).isVisible());
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  const advanced = requests.filter(request => request.path === '/onboarding/advance');
  assert.deepEqual(advanced.map(request => request.input.expectedVersion), [0, 1, 2, 3]);
  assert(advanced.every(request => request.token === 'Bearer ' + tenantA));
  assert.deepEqual(advanced[2].input, { expectedVersion: 2, step: 'invitation', input: { identityId: manager } });
});
