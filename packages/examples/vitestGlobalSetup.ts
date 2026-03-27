import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import kill from 'kill-port';
import type { BrowserServer } from 'playwright-chromium';
import { chromium } from 'playwright-chromium';

const DIR = path.join(os.tmpdir(), 'vitest_playwright_global_setup');

let browserServer: BrowserServer | undefined;

export const setup = async (): Promise<void> => {
  browserServer = await chromium.launchServer({
    headless: !process.env.VITE_DEBUG_SERVE,
    args: process.env.CI
      ? ['--no-sandbox', '--disable-setuid-sandbox']
      : undefined
  });

  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(path.join(DIR, 'wsEndpoint'), browserServer.wsEndpoint());

  // Kill any leftover server processes before touching the temp directory
  // so file handles are released (avoids EBUSY on Windows).
  await kill('5000,5001,5002,5003,5004').catch(() => {});
  if (process.platform === 'win32') {
    await new Promise((r) => setTimeout(r, 2000));
  }

  const tempDir = path.resolve(__dirname, '../../temp');
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });
  await fs
    .cp(path.resolve(__dirname), tempDir, {
      recursive: true,
      filter: (file) => {
        const normalized = file.replace(/\\/g, '/');
        return (
          !normalized.includes('__tests__') && !normalized.match(/dist(\/|$)/)
        );
      }
    })
    .catch(async (error) => {
      if (error.code === 'EPERM' && error.syscall === 'symlink') {
        throw new Error(
          'Could not create symlinks. On Windows, consider activating Developer Mode to allow non-admin users to create symlinks by following the instructions at https://docs.microsoft.com/en-us/windows/apps/get-started/enable-your-device-for-development.'
        );
      } else {
        throw error;
      }
    });
};

export const teardown = async (): Promise<void> => {
  await browserServer?.close();
  if (!process.env.VITE_PRESERVE_BUILD_ARTIFACTS) {
    await kill('5000,5001,5002,5003,5004').catch(() => {});
    if (process.platform === 'win32') {
      await new Promise((r) => setTimeout(r, 2000));
    }
    try {
      await fs.rm(path.resolve(__dirname, '../../temp'), {
        recursive: true,
        force: true
      });
      console.log('temp file is deleted');
    } catch {
      console.log('temp directory still locked, will be cleaned on next run');
    }
  }
};
