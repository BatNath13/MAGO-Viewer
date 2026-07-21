import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: false, // Vite n'ouvre AUCUN navigateur : le launcher .bat ouvre Firefox explicitement.
    fs: {
      allow: ['..'],
    },
  },
  build: {
    outDir: 'api/mago-enrichment-api/public',
    emptyOutDir: true,
    target: 'esnext',
    sourcemap: false, // passe à true pour debug
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      // Inspector est volontairement externe : il est chargé dynamiquement à l'exécution
      // uniquement si l'utilisateur clique sur le bouton, et seulement s'il a été installé.
      external: ['@babylonjs/inspector'],
      output: {
        manualChunks: {
          'babylon-core': ['@babylonjs/core'],
          'babylon-loaders': ['@babylonjs/loaders'],
        },
      },
    },
  },
  optimizeDeps: {
    include: ['@babylonjs/core', '@babylonjs/loaders'],
    exclude: ['@babylonjs/inspector'],
  },
});
