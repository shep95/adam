import { SceneDirector } from '../scenes/director.js';
import { initAnnotations } from '../annotations/index.js';
import { initDrawTool } from '../annotations/drawTool.js';
import { initImageryBoxTool } from '../ui/imageryBoxTool.js';
import { createRecentImageryPanel } from '../ui/recentImagery.js';
import { initGevVoiceCommands } from '../voice/gevRealtime.js';
import { createGevActionRunner } from '../voice/gevActions.js';
import { applyDisplayPolicy } from '../ui/adam/displayPolicy.js';
import { installHudPolicy } from '../ui/adam/hudPolicy.js';
import { createIntelService } from '../intel/intelService.js';
import { installScopeMask, destroyScopeMask } from '../scopeMask.js';
import {
  installRenderGovernor,
  getRenderGovernorDiagnostics,
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';
import { installFrameBudget } from '../frameBudget.js';

/** Attach scene tools, rendering listeners and the application debug handle. */
export function createApplicationTools({
  scene,
  controls,
  data,
  loadingScreen,
  placeSearch,
  voice = {},
  startChrome,
  onSceneDirector,
  sceneDataPacks,
  signal,
  defer,
}) {
  const { viewer, tileset, mapStackController, operations } = scene;
  const { styleManager, weatherEffects, cockpitCloudEffects } = controls;
  const { dataManager } = data;
  const sceneDirector = new SceneDirector(viewer, styleManager, dataManager, {
    dataPacks: sceneDataPacks,
    isMapStackAvailable: (id) =>
      mapStackController?.isStackAvailable(id) === true,
  });
  dataManager.layers
    .get('bhote-koshi-2026')
    ?.module.attachSceneController(sceneDirector);
  defer(() => sceneDirector.destroy());
  onSceneDirector?.(sceneDirector);
  // A `#scene=` share link opens straight into the import review.
  void sceneDirector._sharing?.previewFromLocation?.();
  const annotations = initAnnotations({
    viewer,
    tileset,
    placeSearch,
    resolver: operations.annotationResolver,
  });
  defer(() => {
    if (window.__gevAnnotations === annotations) delete window.__gevAnnotations;
    annotations.destroy();
  });
  // DISPLAY ▸ Draw: the same whiteboard, drawn by hand. It claims the pointer
  // while a session is open, so its teardown belongs to the application
  // lifetime rather than to whoever last pressed the button.
  const drawTool = initDrawTool({ viewer, annotations });
  defer(() => drawTool?.destroy());
  // DATA ▸ Recent Imagery: the box tool claims the pointer like Draw and the
  // panel lives on the right rail, so both belong to the application
  // lifetime. The tileset lets the layer drape while the globe is hidden.
  const recentImagery = dataManager.layers.get('recent-imagery')?.module;
  if (recentImagery) {
    recentImagery.attachTileset(tileset);
    const imageryBoxTool = initImageryBoxTool({
      viewer,
      onBox: (box) => recentImagery.setBox(box),
      onCancel: (reason, message, box) => {
        if (message) recentImagery.reportBoxRefusal(message, box);
      },
      onActive: (active) => recentImagery.setToolActive(active),
      // The tool takes Escape in a capture listener, so the panel's order
      // (clear a preview before cancelling the tool) is applied here.
      onEscape: () => recentImagery.clearPreview(),
    });
    // The readout mounts in its rail body through the layer panel, like the
    // weather readout.
    data.presentation.attachRecentImagery((container) =>
      createRecentImageryPanel({
        container,
        viewer,
        layer: recentImagery,
        tool: imageryBoxTool,
      }),
    );
    // The live gate's handle (scripts/qa-recent-imagery.mjs).
    const recentImageryHandle = { layer: recentImagery, tool: imageryBoxTool };
    window.__gevRecentImagery = recentImageryHandle;
    defer(() => {
      if (window.__gevRecentImagery === recentImageryHandle)
        delete window.__gevRecentImagery;
      data.presentation.attachRecentImagery(null);
      imageryBoxTool?.destroy();
    });
  }
  if (startChrome)
    defer(startChrome({ loadingScreen, styleManager, dataManager, signal }));
  // Idle render governor: flips the scene into requestRenderMode whenever
  // nothing animates per frame. Installed AFTER every module above has had
  // its chance to register pre-install holds. (perf wave 2)
  installRenderGovernor(viewer);
  // Frame budget: shed the ambient grade and freeze animated style shaders
  // when the GPU falls under ~30 fps, then probe back.
  defer(installFrameBudget(viewer));

  // Install the explicit scope mask used by the DISPLAY controls.
  installScopeMask(viewer);
  defer(() => destroyScopeMask());

  // The follow camera recomputes the tracked target's dead-reckon position
  // every frame — tracking anything is a per-frame animation. (perf wave 2)
  const removeTrackingListener = viewer.trackedEntityChanged.addEventListener(
    () => {
      if (viewer.trackedEntity) holdContinuousRender('tracked-entity');
      else releaseContinuousRender('tracked-entity');
    },
  );

  // Hidden-state suspension (perf wave 2): when the window/tab is hidden,
  // stop the default render loop outright — a hidden canvas repaints for
  // nobody, and browser rAF throttling still lets throttled frames burn
  // GPU. Holder/data state is untouched, so return is seamless: restore
  // the loop, refresh the one DOM surface we gated, render a frame.
  const syncVisibilitySuspension = () => {
    const hidden = document.hidden;
    viewer.useDefaultRenderLoop = !hidden;
    cockpitCloudEffects?.setSuspended?.(hidden);
    if (!hidden) {
      data.presentation.flushVisible();
      governorRequestRender('visibility-restore');
    }
  };
  document.addEventListener('visibilitychange', syncVisibilitySuspension);
  defer(() =>
    document.removeEventListener('visibilitychange', syncVisibilitySuspension),
  );
  defer(() => {
    removeTrackingListener();
    releaseContinuousRender('tracked-entity');
  });
  // Apply the CURRENT state too — bootstrap can complete while the tab is
  // already hidden, and waiting for the next transition would leave the
  // loop burning behind a hidden tab. (perf wave 2 fix)
  syncVisibilitySuspension();

  window.__godsEyeView = {
    viewer,
    styleManager,
    tileset,
    dataManager,
    sceneDirector,
    mapStackController,
    annotations,
    weatherEffects,
    cockpitCloudEffects,
    getRenderGovernorDiagnostics,
    surfaceServices: operations.surface,
    requestRender: governorRequestRender,
  };
  const debug = window.__godsEyeView;
  defer(() => {
    if (window.__godsEyeView === debug) delete window.__godsEyeView;
  });
  const voiceCommands = initGevVoiceCommands({
    ...voice,
    floorServices: operations.surface.groundFloor,
    annotationResolver: operations.annotationResolver,
    searchNavigation: operations.searchAndFlyTo,
    signal,
    placeSearch,
    viewer,
    styleManager,
    dataManager,
    sceneDirector,
    annotations,
  });
  defer(() => {
    voiceCommands.stop({ removeUi: true });
    if (window.__gevVoiceCommands === voiceCommands)
      delete window.__gevVoiceCommands;
  });
  debug.voiceCommands = voiceCommands;

  // ADAM intel: baselines, alert triggers, last tracked, pins. The ops deck UI
  // is imported after the globe is up so it never sits on the startup parse.
  const intel = createIntelService({ dataManager }).start();
  // Fine baselines follow the operator's view when zoomed in.
  const syncIntelFocus = () => {
    const canvas = viewer.scene.canvas;
    const hit = viewer.camera.pickEllipsoid(
      { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 },
      viewer.scene.globe.ellipsoid,
    );
    const carto = hit
      ? viewer.scene.globe.ellipsoid.cartesianToCartographic(hit)
      : viewer.camera.positionCartographic;
    intel.setFocus(
      (carto.latitude * 180) / Math.PI,
      (carto.longitude * 180) / Math.PI,
      viewer.camera.positionCartographic.height,
    );
  };
  defer(viewer.camera.moveEnd.addEventListener(syncIntelFocus));
  defer(() => intel.stop());
  debug.intel = intel;
  let opsDeck = null;
  import('../ui/adam/opsDeck.js')
    .then(({ installOpsDeck }) => {
      if (signal?.aborted) return;
      opsDeck = installOpsDeck({
        viewer,
        dataManager,
        intel,
        requestRender: () => governorRequestRender('adam-ops'),
      });
      debug.opsDeck = opsDeck;
    })
    .catch((error) => console.warn('[adam] ops deck failed to load:', error));
  defer(() => opsDeck?.destroy());

  // Shepherd: the text analyst. It drives the console through its own action
  // runner (same handlers as voice, so both stay in step) and can run while
  // a voice session is live.
  let shepherd = null;
  let environment = null;
  let skyPanel = null;
  const shepherdRunner = createGevActionRunner({
    viewer,
    styleManager,
    dataManager,
    sceneDirector,
    annotations,
    placeSearch,
    floorServices: operations.surface.groundFloor,
    annotationResolver: operations.annotationResolver,
    searchNavigation: operations.searchAndFlyTo,
  });
  import('../shepherd/install.js')
    .then(({ installShepherd }) => {
      if (signal?.aborted) return;
      shepherd = installShepherd({
        viewer,
        dataManager,
        intel,
        runGevAction: shepherdRunner,
        mapStackController,
        cesiumToken: mapStackController?.cesiumToken || '',
        getEnvironment: () => environment,
        getSkyPanel: () => skyPanel,
        placeSearch,
      });
      debug.shepherd = shepherd;
    })
    .catch((error) => console.warn('[adam] shepherd failed to load:', error));
  defer(() => shepherd?.destroy());

  const displayPolicy = applyDisplayPolicy({ styleManager });
  defer(() => displayPolicy.destroy());
  const hudPolicy = installHudPolicy({ viewer, dataManager });
  defer(() => hudPolicy.destroy());
  debug.hudPolicy = hudPolicy;

  // Motion language: scan-line, acquisition, trail trace, phosphor bloom,
  // scope waveform, panel drift, NVG/FLIR ignition.
  let motion = null;
  import('../ui/adam/motion.js')
    .then(({ installMotion }) => {
      if (signal?.aborted) return;
      motion = installMotion({ viewer, dataManager });
      debug.motion = motion;
    })
    .catch((error) => console.warn('[adam] motion failed to load:', error));
  defer(() => motion?.destroy());

  // Snapshot, record and interface scale on the top action bar.
  let captureTools = null;
  import('../ui/adam/captureTools.js')
    .then(({ installCaptureTools }) => {
      if (signal?.aborted) return;
      captureTools = installCaptureTools({ viewer });
      debug.capture = captureTools;
    })
    .catch((error) =>
      console.warn('[adam] capture tools failed to load:', error),
    );
  defer(() => captureTools?.destroy());

  // REWIND: scrub the pattern watcher's held track history.
  let rewind = null;
  import('../ui/adam/rewind.js')
    .then(({ installRewind }) => {
      if (signal?.aborted) return;
      rewind = installRewind({ viewer, intel });
      debug.rewind = rewind;
    })
    .catch((error) => console.warn('[adam] rewind failed to load:', error));
  defer(() => rewind?.destroy());

  // CAMERAS: directory of every public camera, with one-click connect.
  let cctvDirectory = null;
  import('../ui/adam/cctvDirectory.js')
    .then(({ installCctvDirectory }) => {
      if (signal?.aborted) return;
      cctvDirectory = installCctvDirectory({ viewer, dataManager });
      debug.cctvDirectory = cctvDirectory;
    })
    .catch((error) =>
      console.warn('[adam] camera directory failed to load:', error),
    );
  defer(() => cctvDirectory?.destroy());

  // The Cesium ion mark is an attribution for ion-served data; without an
  // ion token nothing comes from ion, so the mark is not shown.
  const ionInUse = Boolean(mapStackController?.cesiumToken);
  document.body.classList.toggle('adam-no-ion', !ionInUse);
  defer(() => document.body.classList.remove('adam-no-ion'));

  // Live environment: real sun, moon, stars and shadows for the moment on
  // the clock, with the SKY panel's time controls and local weather.
  let globeSky = null;
  let weatherFx = null;
  let nightLights = null;
  let storm = null;
  Promise.all([
    import('../environment/liveEnvironment.js'),
    import('../ui/adam/skyPanel.js'),
    import('../environment/globeSky.js'),
    import('../environment/weatherFx.js'),
    import('../environment/nightLights.js'),
    import('../environment/stormImmersion.js'),
  ])
    .then(
      ([
        { createLiveEnvironment },
        { installSkyPanel, viewCenter },
        { createGlobeSky },
        { createWeatherFx },
        { createNightLights },
        { createStormImmersion },
      ]) => {
        if (signal?.aborted) return;
        environment = createLiveEnvironment({ viewer });
        globeSky = createGlobeSky({
          viewer,
          environment,
          getCenter: () => viewCenter(viewer),
        });
        weatherFx = createWeatherFx({ viewer });
        nightLights = createNightLights({
          viewer,
          environment,
          getCenter: () => viewCenter(viewer),
          getTileset: () => tileset,
        });
        debug.nightLights = nightLights;
        storm = createStormImmersion({ viewer, weatherFx, globeSky });
        debug.storm = storm;
        skyPanel = installSkyPanel({
          viewer,
          environment,
          dataManager,
          globeSky,
          weatherFx,
        });
        debug.globeSky = globeSky;
        debug.weatherFx = weatherFx;
        debug.environment = environment;
        debug.skyPanel = skyPanel;
      },
    )
    .catch((error) =>
      console.warn('[adam] live environment failed to load:', error),
    );
  defer(() => {
    skyPanel?.destroy();
    storm?.destroy();
    weatherFx?.destroy();
    nightLights?.destroy();
    globeSky?.destroy();
    environment?.destroy();
  });
  return { sceneDirector, annotations, voiceCommands, intel };
}
