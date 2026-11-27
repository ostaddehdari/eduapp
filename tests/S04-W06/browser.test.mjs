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
const contentTypes = new Map([['.html', 'text/html'], ['.js', 'text/javascript'], ['.css', 'text/css'], ['.woff2', 'font/woff2']]);

async function startPanel(t, apiHandler) {
  const output = await mkdtemp(join(tmpdir(), 'eduapp-management-browser-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.VITE_EDUAPP_API_BASE;
  if (apiHandler) env.VITE_EDUAPP_API_BASE = api;
  const build = spawnSync(process.execPath, [
    join(app, 'node_modules/vite/bin/vite.js'), 'build', '--base=./', '--outDir', output,
  ], { cwd: app, env, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (apiHandler && url.pathname.startsWith(api + '/v1/')) {
      try { await apiHandler(url, req, res); } catch { res.writeHead(500).end(); }
      return;
    }
    const file = url.pathname === base ? 'index.html' : url.pathname.slice(base.length);
    if (!url.pathname.startsWith(base) || (file !== 'index.html' && !/^assets\/[A-Za-z0-9._-]+$/.test(file))) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(join(output, file));
      res.writeHead(200, { 'Content-Type': contentTypes.get(extname(file)) }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return 'http://127.0.0.1:' + server.address().port + base + '?view=management';
}

const launch = () => chromium.launch({ executablePath: process.env.EDUAPP_CHROMIUM_EXECUTABLE });

test('the management demo isolates sample scopes and requires a second sample reviewer', { timeout: 45_000 }, async t => {
  const url = await startPanel(t);
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 820 } });
  const apiRequests = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith(api)) apiRequests.push(request.url());
  });
  await page.goto(url);
  await page.getByRole('heading', { name: 'مدیریت پلتفرم و مجموعه' }).waitFor();
  assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert(await page.getByText('اطلاعات و تأییدها نمونه‌اند').isVisible());
  const customerB = page.getByRole('button', { name: /مجموعهٔ باران/ });
  await customerB.click();
  await page.getByText('شعبهٔ آموزشی باران', { exact: true }).first().waitFor();
  assert.equal(await page.getByText('شعبهٔ مرکزی آفتاب', { exact: true }).count(), 0);
  assert(await page.getByRole('heading', { name: 'سهمیه‌ها' }).isVisible());
  assert(await page.getByRole('heading', { name: 'مدیران و نقش‌ها' }).isVisible());

  await page.getByRole('button', { name: 'ثبت درخواست تعلیق' }).click();
  await page.getByText('در انتظار بررسی', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'تأیید درخواست' }).count(), 0);
  assert.match(await customerB.innerText(), /فعال/);

  await page.getByRole('link', { name: 'مدیر آفتاب' }).click();
  await page.getByRole('heading', { name: 'مجموعهٔ فعال' }).waitFor();
  assert.equal(await page.getByText('مجموعهٔ باران', { exact: true }).count(), 0);
  assert.equal(await page.getByText('در انتظار بررسی', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'ثبت درخواست تعلیق' }).count(), 0);

  await page.getByRole('link', { name: 'مالک پلتفرم' }).click();
  await customerB.click();
  await page.getByLabel('نقش تمرینی').selectOption('reviewer');
  await page.getByRole('button', { name: 'تأیید درخواست' }).click();
  await page.getByText('تأیید شد', { exact: true }).waitFor();
  assert.match(await customerB.innerText(), /معلق/);
  assert.match(await page.getByRole('button', { name: /مجموعهٔ آفتاب/ }).innerText(), /فعال/);
  assert.deepEqual(apiRequests, []);
});

test('the configured panel keeps tenant scope and completes a separate approval over HTTP', { timeout: 45_000 }, async t => {
  const a = { id: randomUUID(), slug: 'alpha', displayName: 'مجموعهٔ فرضی الف', status: 'active', version: 1 };
  const b = { id: randomUUID(), slug: 'beta', displayName: 'مجموعهٔ فرضی ب', status: 'active', version: 1 };
  const branch = { id: randomUUID(), parentId: null, kind: 'branch', code: 'alpha-centre', name: 'شعبهٔ الف' };
  const requester = 'fixture-requester@example.test';
  const reviewer = 'fixture-reviewer@example.test';
  const org = 'fixture-org@example.test';
  const roles = new Map([[org, 'organization'], [requester, 'requester'], [reviewer, 'reviewer']]);
  const elevated = new Set();
  const captured = [];
  let approval;

  async function fixture(url, req, res) {
    const path = url.pathname.slice(api.length + 3);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const actor = req.headers.authorization?.slice(7);
    captured.push({ path, actor, body });
    const send = (status, data) => {
      if (status === 204) return res.writeHead(204).end();
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
    };
    if (path === '/auth/login') {
      const mode = roles.get(body.login);
      if (!mode || body.password !== 'sample-auth' || (mode === 'organization' ? body.tenantId !== a.id : body.tenantId !== undefined)) {
        return send(401);
      }
      return send(200, { accessToken: body.login, tenantId: mode === 'organization' ? a.id : null });
    }
    const role = roles.get(actor);
    if (!role) return send(401);
    if (path === '/auth/logout') { elevated.delete(actor); return send(204); }
    if (path === '/auth/mfa/step-up') {
      if (role === 'organization' || body.code !== '123456') return send(401);
      elevated.add(actor);
      return send(200, { verified: true });
    }
    if (path === '/management/overview') {
      const platform = role !== 'organization';
      const target = platform ? [a, b].find(item => item.id === url.searchParams.get('tenantId')) : a;
      return send(200, {
        mode: platform ? 'platform' : 'organization', tenants: platform ? [a, b] : [a],
        selected: target ? {
          tenant: target, branches: target === a ? [branch] : [],
          quotas: platform ? [{ feature: 'active_users', limit: '120', validTo: null }] : [],
          managers: target === a ? [{ membershipId: randomUUID(), orgUnitId: branch.id, roleName: 'مدیر شعبهٔ الف' }] : [],
          approvals: target === b && approval ? [{ ...approval, canDecide: role === 'reviewer' && approval.state === 'pending' }] : [],
          permissions: { requestStatusChange: role === 'requester', decideStatusChange: role === 'reviewer' },
        } : null,
      });
    }
    if (!elevated.has(actor)) return send(403);
    if (path === '/management/status-requests' && role === 'requester' && body.tenantId === b.id &&
      body.expectedVersion === b.version && body.targetStatus === 'suspended') {
      approval = { id: randomUUID(), targetStatus: 'suspended', state: 'pending', expectedVersion: b.version,
        requestedAt: new Date().toISOString(), decidedAt: null, canDecide: false };
      return send(201, approval);
    }
    if (path === '/management/status-requests/' + approval?.id + '/decision' && role === 'reviewer' &&
      body.tenantId === b.id && body.decision === 'approve') {
      b.status = 'suspended';
      b.version += 1;
      approval = { ...approval, state: 'approved', decidedAt: new Date().toISOString() };
      return send(200, approval);
    }
    return send(403);
  }
  const url = await startPanel(t, fixture);
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url + '&sample=baran');
  const login = async (mode, email) => {
    await page.getByLabel('نوع دسترسی').selectOption(mode);
    await page.getByLabel('ایمیل حساب').fill(email);
    await page.getByLabel('رمز عبور').fill('sample-auth');
    if (mode === 'organization') await page.getByLabel('شناسهٔ مجموعه').fill(a.id);
    await page.getByRole('button', { name: 'ورود به مدیریت' }).click();
  };
  await login('organization', org);
  await page.getByRole('heading', { name: 'مجموعهٔ فعال' }).waitFor();
  assert.equal(await page.getByText(b.displayName, { exact: true }).count(), 0);
  assert(await page.getByText('مدیر شعبهٔ الف', { exact: true }).isVisible());
  assert(await page.getByText('سهمیه‌ای در این محدوده قابل مشاهده نیست.').isVisible());
  const logout = () => page.getByRole('button', { name: 'خروج از حساب' }).click();
  await logout();

  await login('platform', requester);
  const customerB = page.getByRole('button', { name: new RegExp(b.displayName) });
  await customerB.click();
  const otp = page.getByLabel('کد تأیید دومرحله‌ای');
  const submit = page.getByRole('button', { name: 'ثبت درخواست تعلیق' });
  await otp.fill('۰۰۰۰۰۰');
  await submit.click();
  await page.getByRole('alert').waitFor();
  assert(!approval);
  await otp.fill('۱۲۳۴۵۶');
  await submit.click();
  await page.getByText('در انتظار بررسی', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'تأیید درخواست' }).count(), 0);
  await logout();

  await login('platform', reviewer);
  await customerB.click();
  await otp.fill('123456');
  await page.getByRole('button', { name: 'تأیید درخواست' }).click();
  await page.getByText('تأیید شد', { exact: true }).waitFor();
  assert.match(await customerB.innerText(), /معلق/);
  const calls = captured.filter(entry => entry.path.startsWith('/management/status-requests'));
  assert.deepEqual(calls.map(entry => [entry.actor, entry.body]), [
    [requester, { tenantId: b.id, targetStatus: 'suspended', expectedVersion: 1 }],
    [reviewer, { tenantId: b.id, decision: 'approve' }],
  ]);
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
});
