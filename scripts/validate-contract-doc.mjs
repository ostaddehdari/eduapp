import { readFile } from 'node:fs/promises';

const target = new URL('../docs/contracts/S01-W01.md', import.meta.url);
const content = await readFile(target, 'utf8');

const required = [
  '**نسخه:** 1.0.0',
  '## 2. مصوبه اولویت محصول',
  '## 3. واحد استقرار و مالکیت دامنه',
  '## 4. قرارداد مشترک API نسخه 1',
  '## 5. قرارداد رویداد',
  '## 6. ماتریس مجوز پایه',
  '## 7. قرارداد استقرار و Worker',
  'GitHub Actions',
  'https://srun.ir/eduapp/api/docs',
  'https://srun.ir/eduapp/api/openapi.json',
  'nginx -t',
  'billing.payment-verified.v1',
  'Idempotency-Key',
  'deny بر allow مقدم است',
];

const missing = required.filter((needle) => !content.includes(needle));
if (missing.length) {
  console.error(`Contract validation failed; missing: ${missing.join(', ')}`);
  process.exit(1);
}

const contexts = [...content.matchAll(/^\| (IAM\/Access|Tenant\/Organization|Persons\/Fields|Commercial\/Billing|Sites\/Domains\/Pages|Assets|School\/Enrollment|Attendance|Notifications|Integrations|Audit\/Jobs) \|/gm)];
if (contexts.length !== 11) {
  console.error(`Contract validation failed; expected 11 owned contexts, got ${contexts.length}`);
  process.exit(1);
}

console.log('PASS S01-W01 contract: version, priorities, 11 owners, API, events, permissions and worker deployment');
