import path from 'node:path';
import { defineConfig } from 'vitest/config';

const pkg = (p: string) => path.resolve(import.meta.dirname, p);

export default defineConfig({
  resolve: {
    alias: {
      '@mc-agent/contracts': pkg('packages/contracts/src/index.ts'),
      '@mc-agent/foundation': pkg('packages/foundation/src/index.ts'),
      '@mc-agent/world': pkg('packages/world/src/index.ts'),
      '@mc-agent/execution': pkg('packages/execution/src/index.ts'),
      '@mc-agent/knowledge': pkg('packages/knowledge/src/index.ts'),
      '@mc-agent/tasks': pkg('packages/tasks/src/index.ts'),
      '@mc-agent/adapters-telemetry': pkg('packages/adapters/telemetry/src/index.ts'),
      '@mc-agent/adapters-mineflayer': pkg('packages/adapters/mineflayer/src/index.ts'),
      '@mc-agent/adapters-client-mod': pkg('packages/adapters/client-mod/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
});
