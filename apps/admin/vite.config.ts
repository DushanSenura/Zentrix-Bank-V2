import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin in dev: the admin talks to the one authoritative API.
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
})
