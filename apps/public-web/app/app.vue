<script setup lang="ts">
import { computed } from 'vue';
import { formatPersianTimestamp, readSchoolPreview, schoolOptions } from '@eduapp/ui-tokens/preview';
import { pageTitle } from './view-model';

const route = useRoute();
const school = computed(() => readSchoolPreview(route.query.school));
const changed = computed(() => formatPersianTimestamp(school.value?.updatedAt));
useHead({ title: pageTitle });
</script>

<template>
  <a
    class="edu-skip"
    href="#main"
  >رفتن به محتوای اصلی</a>
  <header class="edu-header">
    <div class="edu-frame edu-bar">
      <a
        class="edu-brand"
        href="/"
        lang="en"
        dir="ltr"
      >EduApp</a>
      <nav
        class="edu-nav"
        aria-label="ناوبری سایت"
      >
        <a href="#school-preview">نمای مدرسه</a>
        <a href="https://srun.ir/eduapp/api/docs/">راهنمای API</a>
      </nav>
    </div>
  </header>

  <main
    id="main"
    class="edu-frame edu-shell"
    tabindex="-1"
  >
    <section
      class="edu-intro"
      aria-labelledby="page-title"
    >
      <p class="edu-context">
        سایت عمومی EduApp
      </p>
      <h1
        id="page-title"
        class="edu-heading"
      >
        مدیریت مدارس و مجموعه‌های آموزشی
      </h1>
      <p class="edu-description">
        نمای یک مدرسه و زمان آخرین به‌روزرسانی آن را در نمونهٔ رابط کاربری ببینید.
      </p>
      <a
        class="edu-primary"
        href="#school-preview"
      >مشاهدهٔ نمای مدرسه</a>
    </section>

    <section
      id="school-preview"
      class="edu-card"
      aria-labelledby="preview-title"
    >
      <div class="edu-card-head">
        <h2 id="preview-title">
          پیش‌نمایش مدرسه
        </h2>
        <nav
          class="edu-school-links"
          aria-label="انتخاب مدرسهٔ نمونه"
        >
          <a
            v-for="option in schoolOptions"
            :key="option.id"
            :href="'?school=' + option.id"
            :aria-current="school?.id === option.id ? 'true' : undefined"
          >{{ option.name }}</a>
        </nav>
      </div>
      <div class="edu-card-body">
        <template v-if="school">
          <dl class="edu-record">
            <div><dt>مدرسه</dt><dd>{{ school.name }}</dd></div>
            <div>
              <dt>آخرین به‌روزرسانی</dt>
              <dd>
                <time
                  v-if="changed"
                  :datetime="school.updatedAt"
                >{{ changed }}</time><span v-else>در دسترس نیست</span>
              </dd>
            </div>
          </dl>
          <details class="edu-details">
            <summary>جزئیات نمایش</summary>
            <p>این اطلاعات نمونه است. زمان به تاریخ شمسی و ساعت ایران نمایش داده می‌شود.</p>
          </details>
        </template>
        <p
          v-else
          class="edu-error"
          role="status"
        >
          این مدرسه در پیش‌نمایش پیدا نشد. یکی از مدارس نمونه را انتخاب کنید.
        </p>
      </div>
    </section>
  </main>
</template>
