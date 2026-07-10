import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // PORT override lets a second (tool-driven) instance run beside the main
  // dev server on 3003 without stealing its port or popping a browser
  server: {
    open: !process.env.PORT,
    port: Number(process.env.PORT) || 3003,
    strictPort: true,
  },
});
