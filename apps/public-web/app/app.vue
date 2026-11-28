<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { formatPersianTimestamp, readSchoolPreview, schoolOptions } from '@eduapp/ui-tokens/preview';
import { pageTitle } from './view-model';
import { purchaseSummary, readOffers, type Offer } from './purchase';

const route = useRoute();
const school = computed(() => readSchoolPreview(route.query.school));
const changed = computed(() => formatPersianTimestamp(school.value?.updatedAt));
useHead({ title: pageTitle });
const offers = ref<Offer[]>([]);
const offerId = ref('');
const selectedModules = ref<string[]>([]);
const seats = ref(1);
const loading = ref(true);
const catalogError = ref('');
const selectedOffer = computed(() => offers.value.find(item => item.id === offerId.value));
const summary = computed(() => {
  if (!selectedOffer.value) return null;
  try { return purchaseSummary(selectedOffer.value, selectedModules.value, seats.value); }
  catch { return null; }
});
function chooseOffer(id: string) {
  const offer = offers.value.find(item => item.id === id);
  offerId.value = offer?.id ?? '';
  selectedModules.value = offer ? [...offer.modules] : [];
  seats.value = 1;
}
onMounted(async () => {
  try {
    const response = await fetch('/eduapp/api/v1/plans?limit=100', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('فهرست پلن‌ها در دسترس نیست.');
    offers.value = readOffers(await response.json());
    if (offers.value.length) chooseOffer(offers.value[0]!.id);
    else catalogError.value = 'هنوز پلنی برای خرید منتشر نشده است.';
  } catch {
    catalogError.value = 'قیمت‌ها فعلاً در دسترس نیستند. لطفاً بعداً دوباره تلاش کنید.';
  } finally { loading.value = false; }
});
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
        <a href="#purchase">انتخاب پلن</a>
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
      id="purchase"
      class="edu-card edu-purchase"
      aria-labelledby="purchase-title"
    >
      <div class="edu-card-head">
        <h2 id="purchase-title">
          انتخاب پلن
        </h2>
      </div>
      <div class="edu-card-body">
        <p
          v-if="loading"
          role="status"
        >
          در حال دریافت قیمت‌های منتشرشده…
        </p>
        <p
          v-else-if="catalogError"
          role="alert"
          class="edu-error"
        >
          {{ catalogError }}
        </p>
        <template v-else-if="selectedOffer">
          <label for="edu-plan">پلن و نسخه</label>
          <select
            id="edu-plan"
            :value="offerId"
            @change="chooseOffer(($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="offer in offers"
              :key="offer.id"
              :value="offer.id"
            >
              {{ offer.code }}، نسخهٔ {{ offer.version }}
            </option>
          </select>
          <fieldset>
            <legend>ماژول‌های موردنیاز</legend>
            <label
              v-for="module in selectedOffer.modules"
              :key="module"
              class="edu-choice"
            >
              <input
                v-model="selectedModules"
                type="checkbox"
                :value="module"
              >{{ module }}
            </label>
          </fieldset>
          <label for="edu-seats">تعداد صندلی (حداکثر {{ selectedOffer.quotas.seats }})</label>
          <input
            id="edu-seats"
            v-model.number="seats"
            type="number"
            min="1"
            :max="selectedOffer.quotas.seats"
            step="1"
            inputmode="numeric"
          >
          <div
            v-if="summary"
            class="edu-summary"
            aria-live="polite"
          >
            <h3>خلاصه پیش از پرداخت</h3>
            <dl>
              <div><dt>مالک قرارداد</dt><dd>{{ summary.owner }}</dd></div>
              <div><dt>ماژول‌ها</dt><dd>{{ summary.modules.join('، ') || 'هیچ‌کدام' }}</dd></div>
              <div><dt>صندلی</dt><dd>{{ summary.seats }}</dd></div>
              <div><dt>مبلغ پایهٔ پلن</dt><dd>{{ Number(summary.amountMinor).toLocaleString('fa-IR') }} ریال</dd></div>
              <div><dt>مدت قرارداد</dt><dd>{{ summary.termDays }} روز</dd></div>
              <div><dt>آزمایش اولیهٔ مشروط</dt><dd>{{ summary.trialDays }} روز؛ فقط در صورت واجد شرایط بودن</dd></div>
            </dl>
            <p>{{ summary.pricingNote }}</p>
            <p>مبلغ نهایی، تخفیف و شرایط تمدید پس از ورود و دریافت پیش‌فاکتور اختصاصی تأیید می‌شوند. پرداخت در این مرحله فعال نیست.</p>
          </div>
          <p
            v-else
            role="alert"
            class="edu-error"
          >
            تعداد صندلی یا ماژول‌های انتخاب‌شده را اصلاح کنید.
          </p>
        </template>
      </div>
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
