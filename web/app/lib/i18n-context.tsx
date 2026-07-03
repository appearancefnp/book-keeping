'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { messagesFor, type Lang, type MsgKey } from './i18n';
const Ctx = createContext<{ t: (k: MsgKey) => string; lang: Lang; setLang: (l: Lang) => void } | null>(null);
function readCookie(): Lang {
  if (typeof document === 'undefined') return 'lv';
  const m = document.cookie.match(/(?:^|; )bk_lang=(lv|en|ru)/);
  return (m?.[1] as Lang) ?? 'lv';
}
export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('lv');
  useEffect(() => { setLangState(readCookie()); }, []);
  const setLang = (l: Lang) => { document.cookie = `bk_lang=${l}; path=/; max-age=31536000`; setLangState(l); };
  const msgs = messagesFor(lang);
  return <Ctx.Provider value={{ t: (k) => msgs[k] ?? k, lang, setLang }}>{children}</Ctx.Provider>;
}
export function useMessages() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMessages must be used within LanguageProvider');
  return v;
}
