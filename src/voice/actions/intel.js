/**
 * Intel actions: the situational brief and the rolling activity baselines
 * that let the analyst say "activity in this corridor is elevated".
 *
 * Both read the application's intel service (src/intel/intelService.js);
 * without it (tests, headless tools) they answer honestly that no baseline
 * or brief is available rather than inventing one.
 */
import * as Cesium from 'cesium';
import { getIntelService } from '../../intel/intelService.js';
import { getViewTargetCartographic } from './spatial.js';

const BASELINE_LAYER_KEYS = new Set([
  'flights',
  'military',
  'ais-live-vessels',
  'local-firms',
  'earthquakes',
]);

/** Degrees of the point an analyst question is about (scope centre or view). */
export function analystFocusPoint(viewer, args = {}) {
  const center = args?.scope?.center;
  if (Number.isFinite(center?.lat) && Number.isFinite(center?.lon))
    return { lat: center.lat, lon: center.lon };
  try {
    const target = viewer ? getViewTargetCartographic(viewer) : null;
    if (target)
      return {
        lat: Cesium.Math.toDegrees(target.latitude),
        lon: Cesium.Math.toDegrees(target.longitude),
      };
  } catch {
    /* no view target */
  }
  return null;
}

/**
 * Baseline assessments for the queried layers at the question's focus point,
 * compact enough to ride along on an analyst_query result.
 */
export function activityBaselineFor(
  viewer,
  args = {},
  service = getIntelService(),
) {
  if (!service) return null;
  const focus = analystFocusPoint(viewer, args);
  if (!focus) return null;
  const layers = (
    Array.isArray(args.layers) && args.layers.length
      ? args.layers
      : [...BASELINE_LAYER_KEYS]
  ).filter((key) => BASELINE_LAYER_KEYS.has(key));
  const assessments = service.assessAt(focus.lat, focus.lon, layers);
  if (!assessments.length) return null;
  return assessments.map((a) => ({
    layerKey: a.layerKey,
    region: a.regionName,
    level: a.level,
    count: a.count,
    baselineMean: Number.isFinite(a.mean) ? Number(a.mean.toFixed(1)) : null,
    baselineDays: a.days,
    ratio: a.ratio,
    statement: a.statement,
  }));
}

/** Voice action `brief_situation`. */
export async function handleBriefSituation(ctx = {}) {
  const args = ctx.args || {};
  const service = getIntelService();
  if (!service) {
    return {
      ok: false,
      action: 'brief_situation',
      error: 'The intel service is not running, so no brief is available.',
    };
  }
  const format = ['spoken', 'markdown', 'json'].includes(args.format)
    ? args.format
    : 'spoken';
  const brief = service.brief({ delta: Boolean(args.delta), format });
  return {
    ok: true,
    action: 'brief_situation',
    headline: brief.headline,
    spoken: brief.spoken,
    sections: brief.sections,
    anomalies: brief.anomalies.map((a) => ({
      layerKey: a.layerKey,
      region: a.regionName,
      level: a.level,
      statement: a.statement,
    })),
    alerts: brief.alerts,
    feedIssues: brief.feedIssues,
    generatedAt: brief.generatedAt,
    baselineScale: brief.baselineScale,
    ...(brief.delta ? { delta: brief.delta } : {}),
    ...(brief.markdown ? { markdown: brief.markdown } : {}),
  };
}

/** Action name → handler for this domain. */
export const INTEL_ACTIONS = Object.freeze({
  brief_situation: handleBriefSituation,
});
