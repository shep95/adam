/**
 * Shepherd's drawing surface on the globe: precision pins and OSINT entity
 * overlays (nodes with confidence, labelled links). Everything lives in one
 * data source so "clear" is one call and nothing leaks into other layers.
 *
 * Confidence drives presentation: ≥0.7 solid cyan, 0.4–0.7 amber, <0.4 a
 * dim dashed outline — the operator sees certainty before reading a word.
 */
import * as Cesium from 'cesium';
import {
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
} from '../renderGovernor.js';

const MAX_NODES = 200;
const MAX_LINKS = 400;
const PULSE_MS = 3200;
const CYAN = '#00bcd4';
const AMBER = '#f5a623';
const DIM = '#8aa4b8';

export function confidenceTier(confidence) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return 'unknown';
  if (c >= 0.7) return 'strong';
  if (c >= 0.4) return 'moderate';
  return 'weak';
}

const TIER_COLOR = { strong: CYAN, moderate: AMBER, weak: DIM, unknown: DIM };

/** Validate an untrusted overlay payload from the model. */
export function normalizeOverlay(args = {}) {
  const nodes = [];
  const seen = new Set();
  for (const raw of Array.isArray(args.nodes) ? args.nodes : []) {
    if (nodes.length >= MAX_NODES) break;
    const lat = Number(raw?.lat);
    const lon = Number(raw?.lon);
    const id = String(raw?.id ?? '').slice(0, 64);
    if (!id || seen.has(id) || !Number.isFinite(lat) || !Number.isFinite(lon))
      continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    seen.add(id);
    const confidence = Number(raw.confidence);
    nodes.push({
      id,
      label: String(raw.label || id).slice(0, 80),
      lat,
      lon,
      kind: String(raw.kind || 'place').slice(0, 32),
      confidence: Number.isFinite(confidence)
        ? Math.max(0, Math.min(1, confidence))
        : null,
      note: String(raw.note || '').slice(0, 280),
    });
  }
  const links = [];
  for (const raw of Array.isArray(args.links) ? args.links : []) {
    if (links.length >= MAX_LINKS) break;
    const from = String(raw?.from ?? '');
    const to = String(raw?.to ?? '');
    if (!seen.has(from) || !seen.has(to) || from === to) continue;
    links.push({ from, to, label: String(raw.label || '').slice(0, 60) });
  }
  return { title: String(args.title || '').slice(0, 120), nodes, links };
}

/** Bounding view for a set of points. */
export function boundsFor(points) {
  if (!points.length) return null;
  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  for (const p of points) {
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    west = Math.min(west, p.lon);
    east = Math.max(east, p.lon);
  }
  const pad = Math.max(0.02, (north - south) * 0.25, (east - west) * 0.25);
  return {
    south: Math.max(-89, south - pad),
    north: Math.min(89, north + pad),
    west: Math.max(-180, west - pad),
    east: Math.min(180, east + pad),
  };
}

export const OVERLAY_JOURNAL_KEY = 'adam.shepherd.overlay.v1';

export function createShepherdOverlay({
  viewer,
  storage = (() => {
    try {
      return globalThis.localStorage;
    } catch {
      return null;
    }
  })(),
}) {
  // Session autosave: overlays and pins are journaled and replayed on load,
  // so a reload or crash does not lose what Shepherd built.
  let journal = [];
  let replaying = false;
  const saveJournal = () => {
    if (replaying) return;
    try {
      storage?.setItem(OVERLAY_JOURNAL_KEY, JSON.stringify(journal.slice(-60)));
    } catch {
      /* storage full */
    }
  };
  const source = new Cesium.CustomDataSource('adam-shepherd');
  viewer.dataSources.add(source);
  const state = { title: '', nodes: new Map(), links: [], pins: [] };
  let pulseTimer = null;

  const render = () => governorRequestRender('shepherd-overlay');

  function pulse() {
    holdContinuousRender('shepherd-pin-pulse');
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => {
      releaseContinuousRender('shepherd-pin-pulse');
      render();
    }, PULSE_MS);
  }

  function addNodeEntity(node) {
    const tier = confidenceTier(node.confidence);
    const color = Cesium.Color.fromCssColorString(TIER_COLOR[tier]);
    const conf =
      node.confidence === null ? '' : ` · ${node.confidence.toFixed(2)}`;
    source.entities.add({
      id: `shepherd-node-${node.id}`,
      name: node.label,
      position: Cesium.Cartesian3.fromDegrees(node.lon, node.lat),
      point: {
        pixelSize: tier === 'weak' ? 8 : 11,
        color: tier === 'weak' ? color.withAlpha(0.25) : color.withAlpha(0.9),
        outlineColor: color,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: `${node.label.toLowerCase()}${conf}`,
        font: '500 12px "ADAM Mono", ui-monospace, monospace',
        fillColor: color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(12, -10),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2.5e7),
      },
      description: node.note || undefined,
      properties: {
        shepherd: true,
        kind: node.kind,
        confidence: node.confidence,
      },
    });
  }

  function addLinkEntity(link, index) {
    const a = state.nodes.get(link.from);
    const b = state.nodes.get(link.to);
    if (!a || !b) return;
    source.entities.add({
      id: `shepherd-link-${index}-${link.from}-${link.to}`,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray([
          a.lon,
          a.lat,
          b.lon,
          b.lat,
        ]),
        width: 1.5,
        arcType: Cesium.ArcType.GEODESIC,
        clampToGround: true,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString(CYAN).withAlpha(0.6),
          dashLength: 12,
        }),
      },
    });
  }

  function flyToBounds(points) {
    const b = boundsFor(points);
    if (!b) return;
    if (points.length === 1) {
      flyToPoint(points[0].lat, points[0].lon, 1800);
      return;
    }
    viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(
        b.west,
        b.south,
        b.east,
        b.north,
      ),
      duration: 2.2,
      easingFunction: Cesium.EasingFunction.QUINTIC_IN_OUT,
    });
  }

  /**
   * Cinematic approach: arc out, then settle close in at an oblique angle so
   * the spot reads in context, not as a map dot.
   */
  function flyToPoint(lat, lon, range = 900) {
    const target = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
    const sphere = new Cesium.BoundingSphere(target, 20);
    viewer.camera.flyToBoundingSphere(sphere, {
      offset: new Cesium.HeadingPitchRange(
        0,
        Cesium.Math.toRadians(-38),
        range,
      ),
      duration: 2.8,
      maximumHeight: 2.2e6,
      easingFunction: Cesium.EasingFunction.QUINTIC_IN_OUT,
    });
  }

  return {
    source,
    flyToPoint,
    drawOverlay(args) {
      if (!args.append) journal = journal.filter((j) => j.op !== 'overlay');
      journal.push({ op: 'overlay', args: { ...args, fly: false } });
      saveJournal();
      const overlay = normalizeOverlay(args);
      if (!args.append) {
        state.nodes.clear();
        state.links = [];
        source.entities.values
          .filter(
            (e) =>
              String(e.id).startsWith('shepherd-node-') ||
              String(e.id).startsWith('shepherd-link-'),
          )
          .forEach((e) => source.entities.remove(e));
      }
      state.title = overlay.title || state.title;
      for (const node of overlay.nodes) {
        if (state.nodes.has(node.id))
          source.entities.removeById(`shepherd-node-${node.id}`);
        state.nodes.set(node.id, node);
        addNodeEntity(node);
      }
      const start = state.links.length;
      state.links.push(...overlay.links);
      overlay.links.forEach((link, i) => addLinkEntity(link, start + i));
      if (args.fly !== false) flyToBounds(overlay.nodes);
      render();
      return {
        ok: true,
        nodes: state.nodes.size,
        links: state.links.length,
        rejectedNodes: (args.nodes?.length || 0) - overlay.nodes.length,
      };
    },
    dropPin({ lat, lon, label = '', fly = true, range = 900 }) {
      lat = Number(lat);
      lon = Number(lon);
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180
      )
        return { ok: false, error: 'lat/lon out of range' };
      journal.push({ op: 'pin', args: { lat, lon, label, fly: false } });
      journal = [
        ...journal.filter((j) => j.op !== 'pin').slice(-24),
        ...journal.filter((j) => j.op === 'overlay'),
      ];
      saveJournal();
      const id = `shepherd-pin-${state.pins.length}-${Date.now().toString(36)}`;
      const text = String(
        label || `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
      ).slice(0, 80);
      const started = performance.now();
      const position = Cesium.Cartesian3.fromDegrees(lon, lat);
      const cyan = Cesium.Color.fromCssColorString(CYAN);
      source.entities.add({
        id,
        name: text,
        position,
        point: {
          pixelSize: 9,
          color: cyan,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        ellipse: {
          semiMajorAxis: new Cesium.CallbackProperty(() => {
            const t = Math.min(1, (performance.now() - started) / PULSE_MS);
            return 20 + 140 * ((t * 3) % 1);
          }, false),
          semiMinorAxis: new Cesium.CallbackProperty(() => {
            const t = Math.min(1, (performance.now() - started) / PULSE_MS);
            return 20 + 140 * ((t * 3) % 1);
          }, false),
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(() => {
              const t = Math.min(1, (performance.now() - started) / PULSE_MS);
              return t >= 1
                ? cyan.withAlpha(0.12)
                : cyan.withAlpha(0.35 * (1 - ((t * 3) % 1)));
            }, false),
          ),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        label: {
          text: text.toLowerCase(),
          font: '500 12px "ADAM Mono", ui-monospace, monospace',
          fillColor: cyan,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(12, -12),
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      state.pins.push({ id, lat, lon, label: text });
      if (state.pins.length > 24)
        source.entities.removeById(state.pins.shift().id);
      pulse();
      if (fly) flyToPoint(lat, lon, range);
      render();
      return { ok: true, lat, lon, label: text };
    },
    /** Replay the saved journal (after a reload). */
    restore() {
      let saved = [];
      try {
        saved = JSON.parse(storage?.getItem(OVERLAY_JOURNAL_KEY) || '[]');
      } catch {
        saved = [];
      }
      if (!Array.isArray(saved) || !saved.length) return 0;
      replaying = true;
      journal = [];
      for (const j of saved) {
        try {
          if (j?.op === 'overlay') this.drawOverlay({ ...j.args, fly: false });
          else if (j?.op === 'pin') this.dropPin({ ...j.args, fly: false });
        } catch {
          /* skip a bad entry */
        }
      }
      replaying = false;
      saveJournal();
      return saved.length;
    },
    clear() {
      journal = [];
      saveJournal();
      source.entities.removeAll();
      state.nodes.clear();
      state.links = [];
      state.pins = [];
      state.title = '';
      render();
      return { ok: true };
    },
    pinsList: () => state.pins.map((p) => ({ ...p })),
    summary() {
      if (!state.nodes.size && !state.pins.length) return null;
      return `${state.title || 'untitled'} · ${state.nodes.size} nodes · ${state.links.length} links · ${state.pins.length} pins`;
    },
    geojson() {
      const features = [...state.nodes.values()].map((n) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [n.lon, n.lat] },
        properties: {
          id: n.id,
          label: n.label,
          kind: n.kind,
          confidence: n.confidence,
          note: n.note,
        },
      }));
      for (const link of state.links) {
        const a = state.nodes.get(link.from);
        const b = state.nodes.get(link.to);
        if (a && b)
          features.push({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [a.lon, a.lat],
                [b.lon, b.lat],
              ],
            },
            properties: { from: link.from, to: link.to, label: link.label },
          });
      }
      for (const pin of state.pins)
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [pin.lon, pin.lat] },
          properties: { pin: true, label: pin.label },
        });
      return {
        type: 'FeatureCollection',
        name: state.title || 'adam-overlay',
        features,
      };
    },
    destroy() {
      clearTimeout(pulseTimer);
      releaseContinuousRender('shepherd-pin-pulse');
      viewer.dataSources.remove(source, true);
    },
  };
}
