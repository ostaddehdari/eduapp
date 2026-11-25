import { defineNuxtConfig } from 'nuxt/config';

export default defineNuxtConfig({
  compatibilityDate: '2026-11-24',
  devtools: { enabled: false },
  app: { head: { htmlAttrs: { lang: 'fa', dir: 'rtl' } } },
});
