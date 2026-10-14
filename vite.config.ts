import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Prebundle lazy grammars so the first code card does not trigger a dev-server reload.
  optimizeDeps: { include: ['lowlight', ...['typescript', 'javascript', 'json', 'css', 'sql', 'python', 'bash', 'powershell', 'csharp', 'java', 'rust', 'go', 'xml', 'yaml', 'php'].map(language => `highlight.js/lib/languages/${language}`)] },
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/.cache/**', '**/src-tauri/target/**'] } },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: { target: 'es2022', rollupOptions: { input: { main: 'index.html', editor: 'editor.html' } } },
});
