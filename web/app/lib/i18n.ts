export const EN = {
  'nav.queue': 'Approval queue', 'nav.documents': 'Documents', 'nav.overview': 'Overview',
  'nav.tasks': 'Tasks', 'nav.notifications': 'Notifications', 'nav.admin': 'Admin',
  'top.ask': 'Ask', 'top.signOut': 'Sign out', 'top.client': 'Client',
  'login.title': 'Sign in', 'login.email': 'Email', 'login.password': 'Password',
  'login.code': '6-digit code', 'login.submit': 'Continue', 'login.verify': 'Verify',
  'login.badCreds': 'Wrong email or password', 'login.badCode': 'Invalid 2FA code',
  'docs.title': 'Documents', 'docs.upload': 'Upload document', 'docs.empty': 'No documents yet',
  'docs.status.received': 'Received', 'docs.status.extracting': 'Extracting',
  'docs.status.extracted': 'Extracted', 'docs.status.needs_review': 'Needs review',
  'docs.status.posted': 'Posted', 'docs.status.rejected': 'Rejected',
  'over.title': 'Financial overview', 'over.vat': 'VAT position', 'over.receivables': 'Outstanding receivables',
  'over.netPayable': 'Net VAT payable', 'over.trialBalance': 'Trial balance',
  'over.account': 'Account', 'over.debit': 'Debit', 'over.credit': 'Credit', 'over.balance': 'Balance',
  'tasks.title': 'Tasks', 'tasks.empty': 'No open tasks', 'tasks.complete': 'Mark done',
  'tasks.comment': 'Comment', 'tasks.addComment': 'Add comment', 'tasks.resolved': 'Done',
  'notif.title': 'Notifications', 'notif.empty': 'Nothing new', 'notif.markRead': 'Mark read',
  'notif.markAll': 'Mark all read',
  'admin.title': 'Administration', 'admin.clients': 'Clients', 'admin.users': 'Users',
  'admin.audit': 'Audit trail', 'admin.role': 'Role', 'admin.email': 'Email', 'admin.regNo': 'Reg. No',
  'asst.title': 'Assistant', 'asst.placeholder': 'Ask about your books or taxes…', 'asst.send': 'Send',
  'asst.sources': 'Sources', 'asst.thinking': 'Thinking…',
  'state.loading': 'Loading…', 'state.error': 'Something went wrong', 'state.retry': 'Retry',
} as const;

export const LV: Record<keyof typeof EN, string> = {
  'nav.queue': 'Apstiprināšanas rinda', 'nav.documents': 'Dokumenti', 'nav.overview': 'Pārskats',
  'nav.tasks': 'Uzdevumi', 'nav.notifications': 'Paziņojumi', 'nav.admin': 'Administrēšana',
  'top.ask': 'Jautāt', 'top.signOut': 'Iziet', 'top.client': 'Klients',
  'login.title': 'Pieteikties', 'login.email': 'E-pasts', 'login.password': 'Parole',
  'login.code': '6 ciparu kods', 'login.submit': 'Tālāk', 'login.verify': 'Apstiprināt',
  'login.badCreds': 'Nepareizs e-pasts vai parole', 'login.badCode': 'Nederīgs 2FA kods',
  'docs.title': 'Dokumenti', 'docs.upload': 'Augšupielādēt dokumentu', 'docs.empty': 'Vēl nav dokumentu',
  'docs.status.received': 'Saņemts', 'docs.status.extracting': 'Apstrādā',
  'docs.status.extracted': 'Nolasīts', 'docs.status.needs_review': 'Jāpārbauda',
  'docs.status.posted': 'Iegrāmatots', 'docs.status.rejected': 'Noraidīts',
  'over.title': 'Finanšu pārskats', 'over.vat': 'PVN pozīcija', 'over.receivables': 'Neapmaksātie debitori',
  'over.netPayable': 'Maksājamais PVN', 'over.trialBalance': 'Apgrozījuma bilance',
  'over.account': 'Konts', 'over.debit': 'Debets', 'over.credit': 'Kredīts', 'over.balance': 'Atlikums',
  'tasks.title': 'Uzdevumi', 'tasks.empty': 'Nav atvērtu uzdevumu', 'tasks.complete': 'Atzīmēt izpildītu',
  'tasks.comment': 'Komentārs', 'tasks.addComment': 'Pievienot komentāru', 'tasks.resolved': 'Izpildīts',
  'notif.title': 'Paziņojumi', 'notif.empty': 'Nekā jauna', 'notif.markRead': 'Atzīmēt lasītu',
  'notif.markAll': 'Atzīmēt visus lasītus',
  'admin.title': 'Administrēšana', 'admin.clients': 'Klienti', 'admin.users': 'Lietotāji',
  'admin.audit': 'Audita pieraksti', 'admin.role': 'Loma', 'admin.email': 'E-pasts', 'admin.regNo': 'Reģ. Nr',
  'asst.title': 'Asistents', 'asst.placeholder': 'Jautājiet par grāmatvedību vai nodokļiem…', 'asst.send': 'Sūtīt',
  'asst.sources': 'Avoti', 'asst.thinking': 'Domā…',
  'state.loading': 'Ielādē…', 'state.error': 'Radās kļūda', 'state.retry': 'Mēģināt vēlreiz',
};
export const RU: Partial<Record<keyof typeof EN, string>> = {}; // stub; falls back to EN
export type Lang = 'lv' | 'en' | 'ru';
export type MsgKey = keyof typeof EN;
export function messagesFor(lang: Lang): Record<MsgKey, string> {
  if (lang === 'lv') return LV;
  if (lang === 'ru') return { ...EN, ...RU };
  return EN;
}
