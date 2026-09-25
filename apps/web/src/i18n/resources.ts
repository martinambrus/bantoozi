/**
 * i18next resources (spec 09 §1): `common` from src/i18n/common.<lang>.json plus one namespace per
 * feature, discovered from src/features/<feature>/i18n/<lang>.json, so parallel work on different
 * features never edits a shared registration file.
 */
export const LANGUAGES = ['en', 'sk'] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'en';

type Messages = Record<string, unknown>;
type JsonModule = { default: Messages };

const common = import.meta.glob<JsonModule>('./common.*.json', { eager: true });
const features = import.meta.glob<JsonModule>('../features/*/i18n/*.json', { eager: true });

function build(): Record<Language, Record<string, Messages>> {
  const resources: Record<Language, Record<string, Messages>> = { en: {}, sk: {} };
  const add = (lang: string, namespace: string, messages: Messages) => {
    if (!(LANGUAGES as readonly string[]).includes(lang)) {
      throw new Error(`unsupported language file ${namespace}.${lang}`);
    }
    resources[lang as Language][namespace] = messages;
  };
  for (const [path, module] of Object.entries(common)) {
    const lang = /common\.(\w+)\.json$/.exec(path)?.[1];
    if (lang !== undefined) add(lang, 'common', module.default);
  }
  for (const [path, module] of Object.entries(features)) {
    const match = /features\/([\w-]+)\/i18n\/(\w+)\.json$/.exec(path);
    if (match?.[1] !== undefined && match[2] !== undefined) add(match[2], match[1], module.default);
  }
  return resources;
}

export const RESOURCES = build();
export const NAMESPACES = Object.keys(RESOURCES.en);
