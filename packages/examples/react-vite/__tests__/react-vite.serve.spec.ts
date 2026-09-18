import { browserLogs, browserErrors, page } from '~utils';
import { expect, test } from 'vitest';

test('should have no 404s', () => {
  browserLogs.forEach((msg) => {
    expect(msg).not.toMatch('404');
  });
});

test('remote button', async () => {
  expect(await page.textContent('#click-btn')).toBe('Click me: 0');
});

test('click event', async () => {
  await page.click('#click-btn');
  expect(await page.textContent('#click-btn')).toBe('Click me: 1');
});

// store-lib/traditional is a sub-path of the shared package and is bundled
// into the remote; its ESM `import React` and its CJS `require('react')` must
// still bind to the host's React instance (one React, working hooks).
test('shared package sub-path and CJS require use the shared React', async () => {
  expect(await page.getAttribute('#click-btn', 'data-shared-react')).toBe('true');
});

test('no page errors', () => {
  expect(browserErrors.map((e) => e.message)).toEqual([]);
});
