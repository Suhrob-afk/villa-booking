import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Telegram keeps the Mini App's WebView alive between openings, so a client
 * can sit on a months-old bundle indefinitely. Stamping each build and
 * publishing it lets the running app notice it is stale and reload itself.
 */
const BUILD_ID = Date.now().toString(36)

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [
    react(),
    {
      name: 'emit-version',
      closeBundle() {
        writeFileSync(resolve(__dirname, 'dist/version.json'), JSON.stringify({ buildId: BUILD_ID }))
      },
    },
  ],
  server: { port: 5173, host: true },
  build: { outDir: 'dist', sourcemap: false },
})
