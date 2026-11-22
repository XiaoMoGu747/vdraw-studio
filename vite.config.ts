import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 开发模式下 Vite 与 React Refresh 会注入内联脚本，需要放宽 script-src；
 * 生产构建仍使用 index.html 中的严格 CSP。
 */
function devCspPlugin(): Plugin {
  return {
    name: 'vdraw-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html
        .replace(
          "script-src 'self'",
          "script-src 'self' 'unsafe-inline'"
        )
        .replace("default-src 'self';", "default-src 'self'; connect-src 'self' ws: http:;");
    }
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), devCspPlugin()],
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false
  }
});
