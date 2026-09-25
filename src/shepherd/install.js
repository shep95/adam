/**
 * Compose Shepherd: memory, HTTP client, overlay, 3D buildings, executor,
 * agent and chat room. Loaded lazily from src/app/tools.js once the globe is
 * up, so none of it sits on the startup path.
 */
import { createShepherdClient } from './client.js';
import { createShepherdMemory } from './memory.js';
import { createShepherdOverlay } from './overlay.js';
import { createBuildings3d } from './buildings3d.js';
import { createShepherdExecutor } from './executor.js';
import { createShepherdAgent } from './agent.js';
import {
  formatConsoleBlock,
  readConsoleState,
  cameraReading,
} from './consoleState.js';
import { loadTzLookup } from './localTime.js';
import { installShepherdRoom } from '../ui/shepherd/chatRoom.js';
import { installMapInteraction } from '../ui/adam/mapInteraction.js';
import { installNationsPanel } from '../ui/adam/nationsPanel.js';

export function installShepherd({
  viewer,
  dataManager,
  intel,
  runGevAction,
  mapStackController,
  cesiumToken = '',
  getEnvironment = () => null,
  getSkyPanel = () => null,
  placeSearch = null,
}) {
  let nations = null;
  const client = createShepherdClient();
  const memory = createShepherdMemory();
  const overlay = createShepherdOverlay({ viewer });
  const buildings = createBuildings3d({
    viewer,
    mapStackController,
    cesiumToken,
  });
  let tzLookup = null;
  loadTzLookup()
    .then((fn) => {
      tzLookup = fn;
    })
    .catch(() => {});
  const executor = createShepherdExecutor({
    runGevAction,
    viewer,
    dataManager,
    intel,
    overlay,
    buildings,
    client,
    memory,
    getTzLookup: () => tzLookup,
    getEnvironment,
    getSkyPanel,
    getNations: () => nations,
  });
  let room = null;
  const getConsoleBlock = () => {
    const state = readConsoleState({
      viewer,
      dataManager,
      intel,
      overlay,
      buildings,
      tzLookup,
    });
    const focus = memory.topFocus(5);
    let block = formatConsoleBlock(state);
    const env = getEnvironment();
    if (env) {
      const snap = env.snapshot();
      if (snap.mode !== 'live')
        block += `\nscene clock ${snap.date.toISOString()} (simulated, ${snap.playing ? `playing ${snap.speed}×` : 'paused'})`;
    }
    return focus.length
      ? `${block}\noperator focus (learned): ${focus.join(', ')}`
      : block;
  };
  const agent = createShepherdAgent({
    client,
    executor,
    memory,
    getConsoleBlock,
    onEvent: (event) => room?.onAgentEvent(event),
  });
  room = installShepherdRoom({ agent, client, overlay });
  nations = installNationsPanel({
    viewer,
    overlay,
    placeSearch,
    runGevAction,
    room,
  });
  const mapInteraction = installMapInteraction({
    viewer,
    overlay,
    buildings,
    room,
    intel,
    getSkyPanel,
    getEnvironment,
  });

  // Remember where the operator was looking, for the next session's context.
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
    const cam = cameraReading(viewer);
    if (cam) void memory.saveViewport({ ...cam, at: Date.now() });
  });

  return {
    agent,
    room,
    get nations() {
      return nations;
    },
    overlay,
    buildings,
    executor,
    client,
    memory,
    ask: (text) => room.ask(text),
    destroy() {
      agent.abort();
      removeMoveEnd();
      mapInteraction.destroy();
      nations?.destroy();
      room.destroy();
      buildings.destroy();
      overlay.destroy();
    },
  };
}
