export {
  workspaceRoot,
  testDir,
  slash,
  browserLogs,
  browserErrors,
  page,
  browser,
  viteTestUrl
} from './vitestSetup-shared';
import { setupTestSuite } from './vitestSetup-shared';

setupTestSuite({
  env: { NODE_ENV: 'production' },
  buildCommand: 'build',
  startCommands: ['serve']
});
