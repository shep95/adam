/**
 * Mirror the settled basemap onto the document so panel chrome can react.
 *
 * `data-gev-basemap` carries the active stack kind and `data-gev-imagery`
 * reads `heavy` for photographic sources (Google 3D, Bing, Esri) and `light`
 * for cartographic ones. Panels densify their glass over heavy imagery: the
 * world is the background and the panel is the instrument.
 */

const IMAGERY_HEAVY_KINDS = new Set(['photoreal', 'ion', 'esri-imagery']);

/**
 * @param {?{kind?: string}} stack - The active stack descriptor.
 * @returns {'heavy'|'light'}
 */
export function imageryWeightForStack(stack) {
  return IMAGERY_HEAVY_KINDS.has(stack?.kind) ? 'heavy' : 'light';
}

/**
 * @param {?{kind?: string, id?: string}} stack
 * @param {?Document} [doc]
 */
export function syncBasemapChrome(
  stack,
  doc = typeof document === 'undefined' ? null : document,
) {
  const root = doc?.documentElement;
  if (!root?.dataset) return;
  root.dataset.gevBasemap = stack?.kind || 'unknown';
  root.dataset.gevImagery = imageryWeightForStack(stack);
}
