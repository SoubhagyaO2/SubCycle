// Real-browser checks (Chromium via Playwright) against the built web app and the real API.
// Run through `npm run e2e` (it starts both servers), or directly with BASE pointing at a running app.
import { chromium } from 'playwright';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE ?? 'http://localhost:4173';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');
mkdirSync(OUT, { recursive: true });
const results = [];
const log = (ok, what, extra = '') => {
  results.push({ ok, what, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  -> ' + extra : ''}`);
};

async function run(label, viewport) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  const badResponses = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push('console: ' + m.text());
  });
  page.on('response', (r) => {
    if (r.status() >= 400) badResponses.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });

  const shot = async (name) => {
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    log(o.sw <= o.iw + 1, `[${label}] ${name}: no horizontal page scroll`, `scrollWidth=${o.sw} innerWidth=${o.iw}`);
    await page.screenshot({ path: path.join(OUT, `${label}-${name}.png`), fullPage: true });
  };
  const openNav = async () => {
    if (viewport.width < 768) {
      const b = page.getByRole('button', { name: 'Menu' });
      if ((await b.getAttribute('aria-expanded')) === 'false') await b.click();
    }
  };
  const go = async (name) => {
    await openNav();
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name, exact: true }).click();
  };
  const heading = (name) => page.getByRole('heading', { name, exact: true });

  const email = `browser${Date.now()}${label}@example.com`;
  await page.goto(BASE + '/login');
  await heading('Sign in to your account').waitFor();
  await shot('login');

  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Browser Tester');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await heading('Dashboard').waitFor();
  await page.getByText("You don't have a subscription yet").waitFor();
  await shot('dashboard-empty');

  if (viewport.width < 768) {
    const nav = page.locator('#primary-nav');
    log(!(await nav.isVisible()), `[${label}] mobile nav is collapsed initially`);
    await page.getByRole('button', { name: 'Menu' }).click();
    log(await nav.isVisible(), `[${label}] mobile menu opens`);
    await page.getByRole('button', { name: 'Menu' }).click();
  } else {
    log(await page.locator('#primary-nav').isVisible(), `[${label}] desktop nav is visible`);
  }

  await go('Plans');
  await heading('Plans').waitFor();
  await page.getByRole('article', { name: 'Pro', exact: true }).waitFor();
  await shot('pricing');

  // subscribe with the keyboard only
  const subscribeBtn = page.getByRole('article', { name: 'Pro', exact: true }).getByRole('button', { name: 'Subscribe' });
  await subscribeBtn.focus();
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog');
  await dlg.waitFor();
  log(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')), `[${label}] dialog takes focus when opened with Enter`);
  await shot('subscribe-dialog');
  let stayed = true;
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    stayed = stayed && (await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')));
  }
  log(stayed, `[${label}] Tab stays trapped inside the dialog (8 presses)`);
  await page.keyboard.press('Escape');
  await dlg.waitFor({ state: 'hidden' });
  log(await subscribeBtn.evaluate((el) => el === document.activeElement), `[${label}] Escape closes the dialog and returns focus to the opener`);
  await page.keyboard.press('Enter');
  await dlg.waitFor();
  await dlg.getByRole('button', { name: /Pay .* and subscribe/ }).click();
  await heading('Dashboard').waitFor();
  await page.getByText("You're subscribed to Pro.").waitFor();
  await page.getByRole('progressbar', { name: 'API calls used' }).waitFor();
  await shot('dashboard-pro');

  await go('Manage plan');
  await heading('Manage plan').waitFor();
  await page.getByRole('button', { name: 'Upgrade to Business' }).waitFor();
  await shot('manage');
  await page.getByRole('button', { name: 'Upgrade to Business' }).click();
  await page.getByText('Estimated charge now').waitFor();
  await shot('upgrade-dialog');
  await page.getByRole('dialog').getByRole('button', { name: /Confirm and pay/ }).dblclick(); // a double click must be ONE intention
  await page.getByText('You are now on Business.').waitFor();
  await shot('manage-after-upgrade');

  await go('Usage');
  await heading('Usage').waitFor();
  await page.getByRole('button', { name: 'Generate report' }).click();
  await page.getByText('Demo report #1').waitFor();
  await shot('usage');

  await go('Billing');
  await heading('Billing').waitFor();
  const small = viewport.width < 640;
  const invoiceView = small ? page.getByRole('list', { name: /Invoices as cards/ }) : page.getByRole('table', { name: 'Invoices, newest first' });
  await invoiceView.waitFor();
  await shot('billing');
  const invoiceRows = small ? await invoiceView.getByRole('listitem').count() : (await invoiceView.getByRole('row').count()) - 1;
  log(invoiceRows === 2, `[${label}] real invoices: initial + upgrade (exactly one upgrade charge after a double click) in the ${small ? 'card list' : 'table'}`, `items=${invoiceRows}`);
  if (small) {
    const badges = await invoiceView
      .getByText(/^(Paid|Payment failed|Refunded)$/)
      .evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return r.right <= window.innerWidth && r.left >= 0; }));
    log(badges.length === 2 && badges.every(Boolean), `[${label}] invoice status badges are fully on screen`, JSON.stringify(badges));
  }

  await go('History');
  await heading('Subscription history').waitFor();
  await page.getByText('Upgraded to Business').waitFor();
  await shot('history');

  // from the very start of a fresh page load, the first Tab goes to the skip link
  await page.goto(BASE + '/history');
  await heading('Subscription history').waitFor();
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => document.activeElement?.textContent?.trim());
  log(first === 'Skip to main content', `[${label}] first Tab on a fresh load lands on the skip link`, String(first));

  await page.reload();
  await heading('Subscription history').waitFor();
  log(true, `[${label}] reload keeps the session (real localStorage + /auth/me)`);

  log(errors.length === 0, `[${label}] no page or console errors`, errors.slice(0, 3).join(' | '));
  const unexpected = badResponses.filter((r) => !/^404 \/api\/(subscriptions\/current|usage)$/.test(r)); // 404 = "no subscription yet", expected
  log(unexpected.length === 0, `[${label}] no unexpected failing API responses`, unexpected.join(', '));
  await browser.close();
}

(async () => {
  await run('mobile', { width: 375, height: 812 });
  await run('desktop', { width: 1280, height: 800 });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('SCRIPT ERROR', e);
  process.exit(2);
});
