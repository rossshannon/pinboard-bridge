// Each case loads the bridge in a fresh process, since settings are read once at startup.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const load = env => {
  const script = `
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    console.log = () => {};
    const { server, pinboardSettings } = require(${JSON.stringify(path.join(__dirname, '..', 'web.js'))});
    server.close();
    process.stdout.write(JSON.stringify({ settings: pinboardSettings, warnings }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { PATH: process.env.PATH, PORT: '0', ...env },
    encoding: 'utf8'
  });
  return JSON.parse(out);
};

test('a Pinboard budget under 1000 ms is refused, with a warning', () => {
  const { settings, warnings } = load({ PINBOARD_TOTAL_BUDGET_MS: '999' });
  assert.equal(settings.totalBudgetMs, 25000);
  assert.ok(warnings.some(w => w.includes('PINBOARD_TOTAL_BUDGET_MS')), warnings.join(' | '));
});

test('a budget of exactly 1000 ms is accepted', () => {
  const { settings } = load({ PINBOARD_TOTAL_BUDGET_MS: '1000' });
  assert.equal(settings.totalBudgetMs, 1000);
});

test('a budget too small to leave room for queueing warns that spacing is off', () => {
  const { settings, warnings } = load({ PINBOARD_TOTAL_BUDGET_MS: '6000' });
  assert.equal(settings.maxQueueMs, 1000);
  assert.ok(warnings.some(w => w.includes('no call will ever be spaced')), warnings.join(' | '));
});

test('the default settings raise no warnings', () => {
  const { settings, warnings } = load({});
  assert.deepEqual(settings, { minIntervalMs: 3000, totalBudgetMs: 25000, maxQueueMs: 9000 });
  assert.deepEqual(warnings, []);
});
