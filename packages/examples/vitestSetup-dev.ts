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
  buildCommand: 'build:remotes',
  startCommands: ['serve:remotes', 'dev:hosts']
});
