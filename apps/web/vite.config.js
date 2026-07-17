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
  // Railway (and other hosts) probe $PORT on 0.0.0.0 — default vite preview
  // only binds localhost:4173, which causes "Application failed to respond"
  preview: {
    host: '0.0.0.0',
    port: Number(process.env.PORT) || 4173,
    strictPort: true,
    // Vite blocks unknown Host headers by default; Railway serves via *.up.railway.app
    allowedHosts: true,
  },
});
