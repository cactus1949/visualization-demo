/**
 * Root that every runtime data request is built on: `${dataBase()}/data/...` and `${dataBase()}/api/...`.
 * Shared by the first two tabs (manifests, /api/days, buildings) and the globe tab (geo foundation), so a
 * build under a sub path (`vite build --base /viz/`) requests everything under /viz/.
 *
 * VITE_DATA_BASE (an absolute URL or path) wins when non-empty; otherwise Vite's BASE_URL. The result has no trailing
 * slash ("" for the default base "/"). A relative base ("./") is resolved against the page, because the
 * data worker resolves the manifest URL it is given against its own script URL, not the page.
 */
export function resolveDataBase(configured: string | undefined, baseUrl: string, pageHref?: string): string {
  // An empty VITE_DATA_BASE counts as unset, so a sub-path build still follows BASE_URL.
  const raw = configured ? configured : baseUrl;
  let path = raw;
  if (!/^([a-z][a-z\d+.-]*:)?\/\//i.test(raw) && !raw.startsWith("/")) {
    path = pageHref ? new URL(raw || ".", pageHref).pathname : `/${raw.replace(/^\.?\/?/, "")}`;
  }
  return path.replace(/\/+$/, "");
}

export function dataBase(): string {
  const href = typeof location !== "undefined" ? location.href : undefined;
  return resolveDataBase(import.meta.env.VITE_DATA_BASE, import.meta.env.BASE_URL, href);
}
