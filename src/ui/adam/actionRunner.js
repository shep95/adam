/**
 * Run a recommended action (intel.recommend → action) against the live
 * console. Shared by BRIEF's DO buttons and Shepherd's run_recommendation,
 * so a recommendation always does the same thing whoever triggers it.
 * Also draws predicted tracks (line + uncertainty band) on the globe.
 */
import * as Cesium from 'cesium';
import { circleRing } from '../../intel/geoMeasure.js';
import { governorRequestRender } from '../../renderGovernor.js';

const NM_TO_KM = 1.852;

export function createActionRunner({
  viewer,
  dataManager,
  intel,
  getConsole = () => globalThis.__godsEyeView || {},
}) {
  const predictions = new Cesium.CustomDataSource('adam-prediction');
  viewer.dataSources.add(predictions);

  const flyTo = (lat, lon, height = 120_000) =>
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      duration: 1.6,
    });

  function nearestAircraft(lat, lon) {
    let best = null;
    for (const layerKey of ['military', 'flights'])
      for (const r of intel.getRecords(layerKey) || []) {
        if (!Number.isFinite(r.lat) || !r.icao24) continue;
        const d = Math.hypot(
          r.lat - lat,
          (r.lon - lon) * Math.cos((lat * Math.PI) / 180),
        );
        if (!best || d < best.d) best = { d, layerKey, icao24: r.icao24 };
      }
    return best && best.d < 1 ? best : null;
  }

  async function run(action = {}) {
    const c = getConsole();
    switch (action.type) {
      case 'fly':
        flyTo(action.lat, action.lon);
        return { ok: true, did: 'flew there' };
      case 'arm-alert': {
        const km = Math.max(1, (Number(action.radiusNm) || 25) * NM_TO_KM);
        const rule = intel.alerts.add({
          kind: 'count-in-zone',
          layerKey: action.layer || 'military',
          ring: circleRing({ lat: action.lat, lon: action.lon }, km),
          threshold: 0,
          label:
            action.label ||
            `watch ${action.lat.toFixed(2)},${action.lon.toFixed(2)}`,
        });
        if (!rule)
          return { ok: false, error: 'alert rejected (24-rule limit?)' };
        if (!dataManager.isEnabled?.(rule.layerKey))
          await dataManager.setEnabled?.(rule.layerKey, true, {
            origin: 'user',
          });
        return { ok: true, did: `armed ${rule.label}` };
      }
      case 'cctv': {
        const dir = c.cctvDirectory;
        if (!dir) return { ok: false, error: 'camera directory still loading' };
        flyTo(action.lat, action.lon, 20_000);
        const near = await dir.find({
          limit: 1,
          near: { lat: action.lat, lon: action.lon },
        });
        if (!near.length)
          return { ok: false, error: 'no public camera in the catalog' };
        return dir.connect(near[0].id);
      }
      case 'track': {
        const hit = nearestAircraft(action.lat, action.lon);
        if (!hit) {
          flyTo(action.lat, action.lon);
          return {
            ok: false,
            error: 'aircraft not found near there; flew instead',
          };
        }
        const mod = dataManager.layers?.get(hit.layerKey)?.module;
        const ok = Boolean(
          mod?.trackById?.(hit.icao24, { origin: 'programmatic' }),
        );
        return { ok, did: ok ? `tracking ${hit.icao24}` : 'could not track' };
      }
      case 'scenario': {
        const { applyScenario } = await import('./scenarios.js');
        return applyScenario(dataManager, action.id, { intel });
      }
      case 'health':
        c.opsDeck?.toggleView?.('health', true);
        return { ok: true, did: 'opened HEALTH' };
      default:
        return { ok: false, error: `unknown action ${action.type}` };
    }
  }

  /** Draw a predicted track: centre line, band, hour ticks, ETA mark. */
  function showPrediction(result) {
    predictions.entities.removeAll();
    if (!result?.ok || !result.track?.length) return;
    const t = result.track;
    const cyan = Cesium.Color.fromCssColorString('#00BCD4');
    predictions.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(
          t.flatMap((p) => [p.lon, p.lat]),
        ),
        width: 2,
        material: new Cesium.PolylineDashMaterialProperty({
          color: cyan,
          dashLength: 14,
        }),
        clampToGround: true,
      },
    });
    const every = Math.max(1, Math.round(t.length / 8));
    t.forEach((p, i) => {
      if (i === 0 || (i % every !== 0 && i !== t.length - 1)) return;
      predictions.entities.add({
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
        ellipse: {
          semiMajorAxis: p.radiusKm * 1000,
          semiMinorAxis: p.radiusKm * 1000,
          material: cyan.withAlpha(0.06),
          outline: true,
          outlineColor: cyan.withAlpha(0.45),
          height: 0,
        },
        label: {
          text: `+${p.min >= 60 ? `${Math.floor(p.min / 60)}h${String(p.min % 60).padStart(2, '0')}` : `${p.min}m`}`,
          font: '500 10px "ADAM Mono", monospace',
          fillColor: cyan,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    });
    if (result.eta)
      predictions.entities.add({
        position: Cesium.Cartesian3.fromDegrees(result.eta.lon, result.eta.lat),
        point: {
          pixelSize: 9,
          color: Cesium.Color.fromCssColorString('#E53935'),
        },
        label: {
          text: `ENTERS ${result.eta.minutes >= 60 ? `${Math.floor(result.eta.minutes / 60)}h${String(result.eta.minutes % 60).padStart(2, '0')}` : `${result.eta.minutes}m`}`,
          font: '600 11px "ADAM Mono", monospace',
          fillColor: Cesium.Color.fromCssColorString('#E53935'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -16),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    governorRequestRender('adam-prediction');
  }

  return {
    run,
    showPrediction,
    clearPrediction: () => {
      predictions.entities.removeAll();
      governorRequestRender('adam-prediction');
    },
    destroy() {
      viewer.dataSources.remove(predictions, true);
    },
  };
}
