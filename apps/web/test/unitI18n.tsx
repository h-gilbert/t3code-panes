import { GTProvider, initializeGT } from "gt-react";
import type { ReactNode } from "react";

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../src/i18n/locales";

initializeGT({ defaultLocale: DEFAULT_LOCALE, locales: [...SUPPORTED_LOCALES] });

export function withTestI18n(children: ReactNode) {
  return (
    <GTProvider locale={DEFAULT_LOCALE} translations={{ [DEFAULT_LOCALE]: {} }}>
      {children}
    </GTProvider>
  );
}
