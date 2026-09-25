import { TRAFFIC_TIMING_ENABLED } from './policy.js';
import { createStyle } from './style.js';
import { createTiming } from './timing.js';
import { createModel } from './model.js';
import { createIngestion } from './ingestion.js';
import { createAnimation } from './animation.js';
import { createViewport } from './viewport.js';
import { createFlow } from './flow.js';
import { createRendering } from './rendering.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';
import { createState } from './state.js';

/** Construct one layer with its own scene state and supplied application services. */
export function createTrafficLayer({ services, source }) {
  if (
    ![
      'requestRoads',
      'getStatus',
      'fetchFlowForBounds',
      'getFlowSessionStats',
      'resetFlowTileCache',
    ].every((key) => typeof source?.[key] === 'function')
  )
    throw new TypeError('A traffic source is required');
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source };
  parts.style = createStyle(context);
  parts.timing = createTiming(context);
  parts.model = createModel(context);
  parts.ingestion = createIngestion(context);
  parts.animation = createAnimation(context);
  parts.viewport = createViewport(context);
  parts.flow = createFlow(context);
  parts.rendering = createRendering(context);
  parts.controls = createControls(context);
  parts.lifecycle = createLifecycle(context);
  state._parseRoads = TRAFFIC_TIMING_ENABLED
    ? (data, trace) =>
        trace
          ? parts.timing.parseRoadsTimed(data, trace)
          : parts.model.parseRoads(data)
    : parts.model.parseRoads;

  state._loadRoadsForBounds = TRAFFIC_TIMING_ENABLED
    ? parts.timing.loadRoadsForBoundsTimed
    : parts.ingestion.loadRoadsForBounds;

  return Object.assign(
    {},
    parts.controls.methods,
    parts.lifecycle.methods,
    parts.ingestion?.methods,
    {
      getTrafficTimingDiagnostics: parts.timing.getTrafficTimingDiagnostics,
      /** Most congested in-view road segments with live flow (ADAM export). */
      getFlowSnapshot: (options) => trafficFlowSnapshot(state, options),
      deriveTrafficFlowError: parts.flow.deriveTrafficFlowError,
      trafficFeedPresentation: parts.model.trafficFeedPresentation,
    },
  );
}

export { createTrafficSource } from './source.js';

/**
 * Structured congestion snapshot: the worst `limit` roads by TomTom flow
 * ratio (current / free-flow speed; 1 = free flow), closures first, with a
 * representative point, road class and length.
 */
export function trafficFlowSnapshot(state, { limit = 10 } = {}) {
  const roads = Array.isArray(state?._roads) ? state._roads : [];
  const withFlow = [];
  for (const road of roads) {
    const flow = road?.flow;
    if (!flow) continue;
    const level = Number(flow.level ?? flow.trafficLevel);
    const closed = Boolean(flow.closure);
    if (!closed && !Number.isFinite(level)) continue;
    const coords = road.coordinates || [];
    if (coords.length < 2) continue;
    const mid = coords[Math.floor(coords.length / 2)];
    let km = 0;
    for (let i = 1; i < coords.length; i += 1) {
      const [x1, y1] = coords[i - 1];
      const [x2, y2] = coords[i];
      const dx =
        (x2 - x1) * 111.32 * Math.cos((((y1 + y2) / 2) * Math.PI) / 180);
      const dy = (y2 - y1) * 110.57;
      km += Math.hypot(dx, dy);
    }
    withFlow.push({
      roadClass: road.type,
      flowRatio: closed ? 0 : +level.toFixed(2),
      closed,
      lat: +mid[1].toFixed(5),
      lon: +mid[0].toFixed(5),
      lengthKm: +km.toFixed(2),
    });
  }
  withFlow.sort(
    (a, b) => Number(b.closed) - Number(a.closed) || a.flowRatio - b.flowRatio,
  );
  return {
    live: withFlow.length > 0,
    roadsInView: roads.length,
    roadsWithFlow: withFlow.length,
    coveragePct: Number.isFinite(state?._flowCoveragePct)
      ? state._flowCoveragePct
      : null,
    mostCongested: withFlow.slice(0, Math.max(1, Math.min(50, limit))),
  };
}
