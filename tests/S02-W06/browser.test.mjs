import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const root = new URL('../../', import.meta.url);
const localhost = '127.0.0.1';
const types = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.woff2', 'font/woff2'],
]);

async function listen(server) {
  const listening = once(server, 'listening');
  server.listen(0, localhost);
  await listening;
  return server.address().port;
}

async function startApplications(t) {
  const panel = createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://${localhost}`).pathname;
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    const type = types.get(extname(file));
    if (!type || (file !== 'index.html' && !/^assets\/[A-Za-z0-9._-]+$/.test(file))) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(new URL('apps/control-panel/dist/' + file, root));
      res.writeHead(200, { 'Content-Type': type }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  const panelPort = await listen(panel);
  t.after(() => new Promise(resolve => panel.close(resolve)));

  const probe = createServer();
  const webPort = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const web = spawn(process.execPath, ['apps/public-web/.output/server/index.mjs'], {
    cwd: root, stdio: 'ignore',
    env: { ...process.env, NITRO_HOST: localhost, NITRO_PORT: String(webPort) },
  });
  t.after(async () => {
    if (web.exitCode === null && web.signalCode === null) {
      web.kill();
      await once(web, 'exit');
    }
  });

  const publicUrl = `http://${localhost}:${webPort}`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (web.exitCode !== null) break;
    try {
      const response = await fetch(publicUrl);
      await response.body?.cancel();
      if (response.ok) return { publicUrl, panelUrl: `http://${localhost}:${panelPort}` };
    } catch {
      // The application is still starting.
    }
    await delay(100);
  }
  throw new Error('Built Nuxt frontend did not respond. Build both applications before testing.');
}

async function assertKeyboard(page) {
  const summary = page.locator('summary');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'edu-skip');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'main');
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    if (await summary.evaluate(node => node === document.activeElement)) break;
  }
  assert.equal(await summary.evaluate(node => node === document.activeElement), true);
  assert.equal(await summary.evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
  await page.keyboard.press('Enter');
  assert.equal(await summary.evaluate(node => node.parentElement.open), true);
  await page.keyboard.press('Space');
  assert.equal(await summary.evaluate(node => node.parentElement.open), false);
}

function luminance(rgb) {
  const [r, g, b] = rgb.match(/\d+/g).map(Number).map(value => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return .2126 * r + .7152 * g + .0722 * b;
}

test('both built frontends implement the shared UI in Chromium', { timeout: 60_000 }, async (t) => {
  const { publicUrl, panelUrl } = await startApplications(t);
  const browser = await chromium.launch({ executablePath: process.env.EDUAPP_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  for (const [name, url] of Object.entries({ 'Nuxt public web': publicUrl, 'React control panel': panelUrl })) {
    await t.test(name + ' renders RTL and isolated sample schools with accessible interaction', async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
      try {
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(url + '/?school=aftab');
        await page.locator('time').waitFor();
        assert.equal(await page.locator('html').getAttribute('lang'), 'fa');
        assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
        assert.equal(await page.locator('time').getAttribute('datetime'), '2026-03-20T21:00:00Z');
        assert.match(await page.locator('time').innerText(), /۱ فروردین ۱۴۰۵/);
        const style = await page.evaluate(async () => {
          await document.fonts.ready;
          const text = document.querySelector('h1');
          return {
            accent: getComputedStyle(document.documentElement).getPropertyValue('--edu-accent').trim(),
            ink: getComputedStyle(text).color,
            canvas: getComputedStyle(document.body).backgroundColor,
            fontLoaded: Array.from(document.fonts).some(font => font.family.includes('Vazirmatn') && font.status === 'loaded'),
          };
        });
        assert.equal(style.accent, '#174f40');
        assert.equal(style.fontLoaded, true);
        const contrast = (luminance(style.canvas) + 0.05) / (luminance(style.ink) + 0.05);
        assert(contrast >= 4.5, 'heading text contrast');
        await assertKeyboard(page);

        assert.notEqual(await page.locator('summary').evaluate(node => getComputedStyle(node).transitionDuration), '0s');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        assert.equal(await page.locator('summary').evaluate(node => getComputedStyle(node).transitionDuration), '0s');
        await page.setViewportSize({ width: 360, height: 800 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

        await page.getByRole('link', { name: 'مدرسهٔ باران' }).click();
        await page.waitForURL('**/?school=baran');
        await page.locator('time').waitFor();
        assert.equal(await page.locator('time').getAttribute('datetime'), '2026-03-23T05:15:00Z');
        assert.equal(await page.locator('dd').first().innerText(), 'مدرسهٔ باران');

        for (const query of ['school=private-value', 'school=aftab&school=baran']) {
          await page.goto(url + '/?' + query);
          await page.getByRole('status').waitFor();
          assert.match(await page.getByRole('status').innerText(), /در پیش‌نمایش پیدا نشد/);
          assert.equal(await page.locator('time').count(), 0);
          assert(!((await page.locator('main').innerText()).includes('private-value')));
        }
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
  }
});
