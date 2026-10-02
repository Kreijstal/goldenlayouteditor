// The .fla viewer the FLA tab mounts (src/fla-viewer-plugin.js): the parser and canvas
// player of github.com/lifeart/fla-viewer, loaded from its repository through esm.sh
// at the head of master (not pinned), with a toolbar (play, frames, scenes) around them.
// Its package.json doesn't list pako, so esm.sh is told which one (?deps).
import { FLAParser } from "https://esm.sh/gh/lifeart/fla-viewer@master/src/fla-parser.ts?deps=pako@2.1.0";
import { FLAPlayer } from "https://esm.sh/gh/lifeart/fla-viewer@master/src/player.ts?deps=pako@2.1.0";
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== void 0) node.textContent = text;
  return node;
}
function formatFrame(state) {
  const local = `${state.currentFrame + 1} / ${state.totalFrames}`;
  if (state.totalScenes <= 1) return local;
  return `${state.sceneName} - ${local} (${state.globalFrame + 1} / ${state.globalTotalFrames})`;
}
function setDisabled(container, disabled) {
  for (const button of Array.from(container.querySelectorAll("button"))) {
    button.disabled = disabled;
  }
  for (const input of Array.from(container.querySelectorAll("input"))) {
    input.disabled = disabled;
  }
  for (const select of Array.from(container.querySelectorAll("select"))) {
    select.disabled = disabled;
  }
}
function ensureDefaultStyles() {
  if (document.getElementById("fla-viewer-module-style")) return;
  const style = document.createElement("style");
  style.id = "fla-viewer-module-style";
  style.textContent = `
.fla-viewer-root{box-sizing:border-box;display:grid;grid-template-rows:auto 1fr auto;width:100%;height:100%;min-height:0;background:#25282d;color:#f3f4f6;font:13px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.fla-toolbar{display:grid;grid-template-columns:repeat(5,auto) minmax(96px,180px) minmax(140px,1fr) 96px auto;align-items:center;gap:8px;padding:8px;border-bottom:1px solid rgba(255,255,255,.12);background:#31353b}
.fla-toolbar button,.fla-toolbar select{height:28px;border:1px solid rgba(255,255,255,.18);border-radius:4px;background:#424852;color:#fff;font:inherit}
.fla-toolbar button{min-width:52px;padding:0 10px}.fla-toolbar button:disabled,.fla-toolbar input:disabled,.fla-toolbar select:disabled{opacity:.55}.fla-toolbar input[type=range]{width:100%}
.fla-frame-label{min-width:160px;color:#d1d5db;white-space:nowrap;text-align:right}.fla-stage-wrap{min-height:0;display:flex;align-items:center;justify-content:center;overflow:auto;background:#181a1f}
.fla-stage{display:block;max-width:100%;max-height:100%;background:#fff}.fla-status{min-height:28px;padding:6px 10px;border-top:1px solid rgba(255,255,255,.12);color:#cbd5e1;background:#25282d;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (max-width:720px){.fla-toolbar{grid-template-columns:repeat(5,auto) minmax(0,1fr)}.fla-toolbar select,.fla-toolbar input[type=range],.fla-frame-label{grid-column:1/-1;min-width:0;text-align:left}}`;
  document.head.appendChild(style);
}
async function mountFLAViewer(root, options) {
  ensureDefaultStyles();
  root.textContent = "";
  root.classList.add("fla-viewer-root");
  const toolbar = el("div", "fla-toolbar");
  const playButton = el("button", "", "Play");
  const stopButton = el("button", "", "Stop");
  const prevButton = el("button", "", "Prev");
  const nextButton = el("button", "", "Next");
  const skipButton = el("button", "", "Skip Recovery");
  const sceneSelect = el("select");
  const frameRange = el("input");
  frameRange.type = "range";
  frameRange.min = "0";
  frameRange.max = "0";
  frameRange.value = "0";
  const volume = el("input");
  volume.type = "range";
  volume.min = "0";
  volume.max = "1";
  volume.step = "0.01";
  volume.value = "1";
  const frameLabel = el("span", "fla-frame-label", "Loading...");
  toolbar.append(playButton, stopButton, prevButton, nextButton, skipButton, sceneSelect, frameRange, volume, frameLabel);
  const stageWrap = el("div", "fla-stage-wrap");
  const canvas = el("canvas", "fla-stage");
  stageWrap.appendChild(canvas);
  const status = el("div", "fla-status", `Loading ${options.name || "FLA"}...`);
  root.append(toolbar, stageWrap, status);
  setDisabled(toolbar, true);
  const player = new FLAPlayer(canvas);
  let disposed = false;
  let skipImageRecovery = false;
  function updateState() {
    const state = player.getState();
    playButton.textContent = state.playing ? "Pause" : "Play";
    frameRange.max = String(Math.max(0, state.totalFrames - 1));
    frameRange.value = String(state.currentFrame);
    frameLabel.textContent = formatFrame(state);
    sceneSelect.value = String(state.currentScene);
  }
  player.onStateUpdate(updateState);
  playButton.onclick = () => {
    const state = player.getState();
    if (state.playing) player.pause();
    else player.play();
  };
  stopButton.onclick = () => player.stop();
  prevButton.onclick = () => player.prevFrame();
  nextButton.onclick = () => player.nextFrame();
  frameRange.oninput = () => player.goToFrame(Number(frameRange.value));
  volume.oninput = () => player.setVolume(Number(volume.value));
  sceneSelect.onchange = () => player.goToScene(Number(sceneSelect.value));
  skipButton.onclick = () => {
    skipImageRecovery = true;
    skipButton.disabled = true;
    status.textContent = "Skipping image recovery...";
  };
  const resizeObserver = new ResizeObserver(() => {
    try {
      player.updateCanvasSize();
    } catch (_) {
    }
  });
  resizeObserver.observe(stageWrap);
  try {
    const response = await fetch(options.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const magic = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    const isOleCompound = magic[0] === 208 && magic[1] === 207 && magic[2] === 17 && magic[3] === 224 && magic[4] === 161 && magic[5] === 177 && magic[6] === 26 && magic[7] === 225;
    if (isOleCompound) {
      throw new Error("This is an older binary Compound FLA. The ported fla-viewer parser supports ZIP/XFL-based FLA files.");
    }
    const file = new File([blob], options.name || "document.fla", { type: blob.type || "application/zip" });
    const parser = new FLAParser();
    skipButton.disabled = false;
    const doc = await parser.parse(file, (message) => {
      status.textContent = message;
    }, () => skipImageRecovery);
    if (disposed) return { destroy() {
    } };
    status.textContent = `${doc.width} x ${doc.height}, ${doc.frameRate} fps, ${doc.timelines.length} scene${doc.timelines.length === 1 ? "" : "s"}`;
    sceneSelect.textContent = "";
    doc.timelines.forEach((timeline, index) => {
      const option = el("option");
      option.value = String(index);
      option.textContent = timeline.name || `Scene ${index + 1}`;
      sceneSelect.appendChild(option);
    });
    await player.setDocument(doc);
    setDisabled(toolbar, false);
    skipButton.disabled = true;
    updateState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status.textContent = `Failed to load FLA: ${message}`;
    console.error(error);
  }
  return {
    destroy() {
      disposed = true;
      player.pause();
      resizeObserver.disconnect();
      root.textContent = "";
    }
  };
}
export {
  mountFLAViewer
};
