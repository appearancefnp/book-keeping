type Lang = 'lv' | 'ru' | 'en';
const CATALOG: Record<string, Record<Lang, string>> = {
  approve: { lv: 'Apstiprināt', ru: 'Подтвердить', en: 'Approve' },
  reject: { lv: 'Noraidīt', ru: 'Отклонить', en: 'Reject' },
  approval_queue: { lv: 'Apstiprināšanas rinda', ru: 'Очередь подтверждений', en: 'Approval queue' },
};
export function t(lang: Lang, key: string): string {
  return CATALOG[key]?.[lang] ?? CATALOG[key]?.en ?? key;
}
