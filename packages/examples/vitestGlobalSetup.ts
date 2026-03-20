import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import kill from 'kill-port'
import type { BrowserServer } from 'playwright-chromium'
import { chromium } from 'playwright-chromium'

const DIR = path.join(os.tmpdir(), 'vitest_playwright_global_setup')

let browserServer: BrowserServer | undefined

export async function setup(): Promise<void> {
  browserServer = await chromium.launchServer({
    headless: !process.env.VITE_DEBUG_SERVE,
    args: process.env.CI
      ? ['--no-sandbox', '--disable-setuid-sandbox']
      : undefined
  })

  await fs.mkdirp(DIR)
  await fs.writeFile(path.join(DIR, 'wsEndpoint'), browserServer.wsEndpoint())

  // Kill any leftover server processes before touching the temp directory
  // so file handles are released (avoids EBUSY on Windows).
  await kill('5000,5001,5002,5003,5004').catch(() => {})
  if (process.platform === 'win32') {
    await new Promise((r) => setTimeout(r, 2000))
  }

  const tempDir = path.resolve(__dirname, '../temp')
  await fs.ensureDir(tempDir)
  try {
    await fs.emptyDir(tempDir)
  } catch {
    // Retry once after a short delay (Windows file-lock release).
    await new Promise((r) => setTimeout(r, 2000))
    await fs.emptyDir(tempDir)
  }
  await fs
    .copy(path.resolve(__dirname, '../examples'), tempDir, {
      dereference: false,
      filter(file) {
        file = file.replace(/\\/g, '/')
        return !file.includes('__tests__') && !file.match(/dist(\/|$)/)
      }
    })
    .catch(async (error) => {
      if (error.code === 'EPERM' && error.syscall === 'symlink') {
        throw new Error(
          'Could not create symlinks. On Windows, consider activating Developer Mode to allow non-admin users to create symlinks by following the instructions at https://docs.microsoft.com/en-us/windows/apps/get-started/enable-your-device-for-development.'
        )
      } else {
        throw error
      }
    })
}

export async function teardown(): Promise<void> {
  await browserServer?.close()
  if (!process.env.VITE_PRESERVE_BUILD_ARTIFACTS) {
    // Best-effort cleanup. If the temp directory is still locked (Windows),
    // the next run's setup will clean it before re-copying.
    await kill('5000,5001,5002,5003,5004').catch(() => {})
    if (process.platform === 'win32') {
      await new Promise((r) => setTimeout(r, 2000))
    }
    try {
      await fs.remove(path.resolve(__dirname, '../temp'))
      console.log('temp file is deleted')
    } catch {
      console.log('temp directory still locked, will be cleaned on next run')
    }
  }
}
