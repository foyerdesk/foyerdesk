// To add a language: create <code>.js with the same keys as en.js, import it here and add it to `languages`.
import en from "./en.js";

export const languages = { en };

export function translator(code = "en") {
  const dictionary = languages[String(code).toLowerCase().split("-")[0]] ?? en;
  return (key, vars = {}) => {
    const template = dictionary[key] ?? en[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_, name) => (name in vars ? String(vars[name]) : `{${name}}`));
  };
}
