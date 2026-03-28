import { execa, type ExecaChildProcess } from 'execa';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-chromium';
import type { Browser, Page } from 'playwright-chromium';
import type { RunnerTestFile } from 'vitest';
import { beforeAll, afterAll } from 'vitest';

export const workspaceRoot = resolve(__dirname, '../../');

export const slash = (p: string): string => p.replace(/\\/g, '/');

export const DEFAULT_PORT = 5000;

export const browserLogs: string[] = [];
export const browserErrors: Error[] = [];

export let page: Page = undefined!;
export let browser: Browser = undefined!;
export let testDir: string;
export let viteTestUrl: string = '';

const DIR = join(os.tmpdir(), 'vitest_playwright_global_setup');

interface ModeConfig {
  env?: Record<string, string>;
  buildCommand: string;
  startCommands: string[];
}

let err: Error;
let skipError: boolean;
let serverProcesses: ExecaChildProcess[] = [];

const connectBrowser = async (): Promise<void> => {
  const wsEndpoint = readFileSync(join(DIR, 'wsEndpoint'), 'utf-8');
  if (!wsEndpoint) {
    throw new Error('wsEndpoint not found');
  }
  browser = await chromium.connect(wsEndpoint);
  page = await browser.newPage();
};

const suppressReactivityWarning = (): void => {
  const globalConsole = global.console;
  const warn = globalConsole.warn;
  globalConsole.warn = (msg: string, ...args: unknown[]) => {
    if (msg.includes('@vue/reactivity-transform')) return;
    warn.call(globalConsole, msg, ...args);
  };
};

const attachPageListeners = (): void => {
  page.on('console', (msg) => {
    browserLogs.push(msg.text());
  });
  page.on('pageerror', (error) => {
    browserErrors.push(error);
  });
};

export const setupTestSuite = (config: ModeConfig): void => {
  beforeAll(async ({}, s) => {
    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        process.env[key] = value;
      }
    }

    const suite = s as RunnerTestFile;
    if (!suite?.filepath?.includes('examples')) {
      return;
    }

    await connectBrowser();
    suppressReactivityWarning();

    skipError = false;
    try {
      attachPageListeners();

      const testPath = suite.filepath!;
      const testName = slash(testPath).match(
        /packages\/examples\/([\w-]+)\//
      )?.[1];
      testDir = dirname(testPath);

      if (testName) {
        testDir = resolve(workspaceRoot, 'temp', 'packages', 'examples', testName);

        await execa('pnpm', ['run', config.buildCommand], {
          cwd: testDir,
          stdio: 'inherit'
        });

        for (const cmd of config.startCommands) {
          serverProcesses.push(
            execa('pnpm', ['run', cmd], {
              cwd: testDir,
              stdio: 'inherit',
              reject: false
            })
          );
        }

        viteTestUrl = `http://localhost:${DEFAULT_PORT}`;
        await new Promise((r) => setTimeout(r, 3000));
        await page.goto(viteTestUrl);
      }
    } catch (e) {
      if (!skipError) {
        err = e as Error;
      }
      await page.close();
    }
  }, 60000);

  afterAll(async () => {
    await page?.close();
    skipError = true;
    try {
      await execa('pnpm', ['run', 'stop'], {
        cwd: testDir,
        stdio: 'inherit'
      });
    } catch {
      // kill-port may exit non-zero when no process is found; safe to ignore.
    }
    await Promise.all(serverProcesses.map((p) => p.catch(() => {})));
    serverProcesses = [];
    if (browser) {
      await browser.close();
    }
    if (err) {
      throw err;
    }
  });
};
