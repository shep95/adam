/**
 * Present weather drawn over the view: rain streaks, snow, thunderstorm
 * flashes — from the live observation at the view centre, and only when the
 * camera is low enough to be "in" the weather (below ~25 km). A single
 * canvas, animated only while something is falling.
 */

/** WMO weather code → precipitation kind and intensity (0–1). */
export function precipitationFor(weather) {
  const code = Number(weather?.weatherCode);
  const mm = Number(weather?.precipitationMm) || 0;
  if (!Number.isFinite(code))
    return { kind: 'none', intensity: 0, thunder: false };
  const thunder = code >= 95;
  let kind = 'none';
  let base = 0;
  if ([71, 73, 75, 77, 85, 86].includes(code)) {
    kind = 'snow';
    base = { 71: 0.3, 73: 0.55, 75: 0.9, 77: 0.25, 85: 0.5, 86: 0.9 }[code];
  } else if (
    (code >= 51 && code <= 67) ||
    (code >= 80 && code <= 82) ||
    thunder
  ) {
    kind = 'rain';
    base =
      {
        51: 0.15,
        53: 0.25,
        55: 0.35,
        56: 0.25,
        57: 0.4,
        61: 0.35,
        63: 0.6,
        65: 0.9,
        66: 0.4,
        67: 0.8,
        80: 0.4,
        81: 0.65,
        82: 0.95,
      }[code] ?? 0.8;
  } else if (code === 45 || code === 48) {
    kind = 'fog';
    base = 0.5;
  }
  const intensity = Math.max(
    0,
    Math.min(1, Math.max(base, Math.min(1, mm / 6))),
  );
  return { kind, intensity: kind === 'none' ? 0 : intensity, thunder };
}

export function createWeatherFx({ viewer, doc = document }) {
  const canvas = doc.createElement('canvas');
  canvas.className = 'adam-weather-fx';
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    pointerEvents: 'none',
    zIndex: '90',
    opacity: '0',
    transition: 'opacity 600ms ease',
  });
  doc.body.append(canvas);
  const ctx = canvas.getContext('2d');
  let precip = { kind: 'none', intensity: 0, thunder: false };
  let windDeg = 0;
  let windKph = 0;
  let enabled = true;
  let particles = [];
  let raf = 0;
  let flash = 0;

  function resize() {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.width = Math.round(globalThis.innerWidth * dpr);
    canvas.height = Math.round(globalThis.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  globalThis.addEventListener('resize', resize);

  function lowEnough() {
    return viewer.camera.positionCartographic.height < 25_000;
  }

  function seed() {
    const w = globalThis.innerWidth;
    const h = globalThis.innerHeight;
    const n =
      Math.round((precip.kind === 'snow' ? 260 : 420) * precip.intensity) + 20;
    particles = Array.from({ length: n }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      v:
        precip.kind === 'snow'
          ? 0.6 + Math.random() * 1.2
          : 12 + Math.random() * 10,
      r:
        precip.kind === 'snow'
          ? 1 + Math.random() * 2.2
          : 0.6 + Math.random() * 0.8,
      l: 10 + Math.random() * 16,
      p: Math.random() * Math.PI * 2,
    }));
  }

  function frame() {
    raf = 0;
    const w = globalThis.innerWidth;
    const h = globalThis.innerHeight;
    ctx.clearRect(0, 0, w, h);
    // Screen-space drift from the wind (camera heading ignored: a hint, not a model).
    const drift =
      Math.sin(((windDeg + 180) * Math.PI) / 180) * Math.min(1, windKph / 60);
    if (precip.kind === 'rain') {
      ctx.strokeStyle = `rgba(190, 215, 235, ${0.25 + 0.35 * precip.intensity})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const p of particles) {
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + drift * p.l, p.y + p.l);
        p.y += p.v;
        p.x += drift * p.v * 0.4;
        if (p.y > h) {
          p.y = -p.l;
          p.x = Math.random() * w;
        }
      }
      ctx.stroke();
    } else if (precip.kind === 'snow') {
      ctx.fillStyle = 'rgba(245, 250, 255, 0.85)';
      for (const p of particles) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        p.p += 0.02;
        p.y += p.v;
        p.x += Math.sin(p.p) * 0.6 + drift * 1.2;
        if (p.y > h) {
          p.y = -4;
          p.x = Math.random() * w;
        }
      }
    }
    if (precip.thunder) {
      if (flash <= 0 && Math.random() < 0.004) flash = 1;
      if (flash > 0) {
        ctx.fillStyle = `rgba(220, 230, 255, ${0.35 * flash})`;
        ctx.fillRect(0, 0, w, h);
        flash -= 0.08;
      }
    }
    if (active()) raf = requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, w, h);
  }

  function active() {
    return (
      enabled &&
      (precip.kind === 'rain' || precip.kind === 'snow') &&
      lowEnough() &&
      !doc.hidden
    );
  }

  function refresh() {
    const on = active();
    canvas.style.opacity = on ? '1' : '0';
    if (on && !raf) raf = requestAnimationFrame(frame);
  }

  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(refresh);
  const onVisibility = () => refresh();
  doc.addEventListener('visibilitychange', onVisibility);

  return {
    setWeather(weather) {
      const next = precipitationFor(weather);
      const changed =
        next.kind !== precip.kind ||
        Math.abs(next.intensity - precip.intensity) > 0.05;
      precip = next;
      windDeg = Number(weather?.windDirectionDeg) || 0;
      windKph = Number(weather?.windKph) || 0;
      if (changed) seed();
      refresh();
      return precip;
    },
    setEnabled(on) {
      enabled = Boolean(on);
      refresh();
    },
    state: () => ({ ...precip, enabled, showing: active() }),
    destroy() {
      cancelAnimationFrame(raf);
      removeMoveEnd();
      doc.removeEventListener('visibilitychange', onVisibility);
      globalThis.removeEventListener('resize', resize);
      canvas.remove();
    },
  };
}
