/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './',
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        runtime: resolve(__dirname, 'runtime.html'),
      },
    },
  },
  server: { port: 5173, host: true },
});
