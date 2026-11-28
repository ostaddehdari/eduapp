import { defineNuxtConfig } from 'nuxt/config';

export default defineNuxtConfig({
  compatibilityDate: '2026-11-24',
  devtools: { enabled: false },
  css: ['@eduapp/ui-tokens/theme.css', '~/app/purchase.css'],
  app: { head: { htmlAttrs: { lang: 'fa', dir: 'rtl' } } },
});
