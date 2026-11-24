export interface FoyerdeskOptions {
  lang?: string;
  apiBase?: string;
  authBase?: string;
  loginUrl?: string;
  brand?: string;
  /** 1 (default) or 2: use 2 when the host page already has its own h1. */
  headingLevel?: 1 | 2;
}
export function mountFoyerdesk(root: HTMLElement, options?: FoyerdeskOptions): { destroy(): void };
