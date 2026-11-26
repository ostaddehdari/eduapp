export const schoolOptions: ReadonlyArray<Readonly<{ id: string; name: string }>>;
export function formatPersianTimestamp(timestamp: unknown): string | null;
export function readSchoolPreview(value: unknown): {
  id: string;
  name: string;
  updatedAt: string;
} | null;
