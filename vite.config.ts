import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ base: '/json-world/', plugins: [react()], build: { chunkSizeWarningLimit: 1000 }, test: { include: ['src/**/*.test.ts'] } } as any);
