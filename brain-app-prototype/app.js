// ═══════════════════════════════════════════════════════════════════════════════
// app.js — "Neural Hologram" engine (Three.js)
//
// WHY THIS EXISTS
//   v1 used NiiVue volumetric raycasting (mni152 + aal .nii.gz) → crashed the
//   Intel Iris Xe (CONTEXT_LOST_WEBGL). v2 fell back to a NiiVue .glb mesh with
//   floating connectome marbles — but NiiVue's mesh path fought us at every step
//   (broken GLB parser, no per-mesh alpha, opaque-only passes, inverted zoom).
//
//   v3 (this file) pivots to a hand-built Three.js scene tuned for integrated
//   graphics: ONE low-poly glass-shader cortex shell, emissive neural tracts with
//   a scrolling "energy-flow" texture, and glowing region nodes with additive
//   sprite halos. No volume textures, no raymarching, no post-processing bloom
//   passes — the glow is faked with cheap additive sprites so it stays buttery on
//   a shared GPU. Target: a sleek dark-mode medical hologram.
//
// PERFORMANCE BUDGET (Iris Xe safe)
//   • Single WebGLRenderer, antialias off, devicePixelRatio capped at 1.5.
//   • ~24k-vertex cortex mesh (trivial), unlit Fresnel shader (no lighting cost).
//   • ~8 tract tubes (6 radial segments) + ~30 nodes + additive halos.
//   • GPU-only tract flow (texture-offset scroll) — near-zero CPU per frame.
//   • rAF loop pauses when the tab is hidden; graceful WebGL-context-loss card.
//
// PUBLIC API (window.brain) is preserved 1:1 from the NiiVue build, so game.js,
// the Digital Twin HUD, the cinematic tour and the PDF snapshot keep working.
//
// Z-SCORE COLOUR LOGIC (unchanged):  Red = deficit · Violet = hyper · Cyan = active
// ═══════════════════════════════════════════════════════════════════════════════

import { CONNECTOME_DATABASE, classify, NORMATIVE, AAL_CENTROID_MNI,
         RS_NETWORKS, DEEP_NODES, NETWORK_EDGES } from './connectome_database.js?v=20260704b';
import { playHeartbeat } from './audioManager.js?v=20260704b';

// ─── Assets ───────────────────────────────────────────────────────────────────
// brain_mesh.obj is the cortex surface re-extracted from the Sketchfab GLB (the
// NiiVue GLB loader produced degenerate verts) and re-saved as plain OBJ, scaled
// to roughly MNI-mm extent. Parsed here with a tiny local parser (no OBJLoader
// dependency needed — the file is only `v`/`f` lines).
const BRAIN_MESH_URL = './brain_mesh.obj';

// ─── Region → AAL label indices (drives node + tract placement) ───────────────
const REGION_TO_AAL = {
  leftHippocampus:  [37], rightHippocampus:  [38],
  leftParaHippo:    [39], rightParaHippo:    [40],
  leftAmygdala:     [41], rightAmygdala:     [42],
  anteriorCingulate:[31, 32], dACC: [31, 32],
  leftFrontal:  [3, 7, 23], rightFrontal:  [4, 8, 24],
  leftParietal: [59, 61],   rightParietal: [60, 62],
  leftTemporal: [81, 85, 89], rightTemporal: [82, 86, 90],
  leftOccipital:[49, 51, 53], rightOccipital:[50, 52, 54],
  leftIFG:        [11, 13], rightIFG:        [12, 14],
  leftDLPFC:      [7],      rightDLPFC:      [8],
  leftVmPFC:      [25, 27], rightVmPFC:      [26, 28],
  leftPrecentral: [1],      rightPrecentral: [2],
  leftSMA:        [19],     rightSMA:        [20],
};

// Cognitive-test region → AAL labels (live gameplay node highlight).
const COGNITIVE_REGION_AAL = {
  readingGame:       [85, 89, 81, 11, 13],
  nBackGame:         [59, 61, 7, 8, 3, 4, 60, 62],
  corsiGame:         [37, 38, 39, 40],
  stroopTask:        [31, 32, 7, 8],
  fluencyGame:       [11, 12, 13, 14],
  aq10Game:          [41, 42, 25, 26, 27, 28],
  fingerTappingGame: [1, 2, 19, 20],
  goNoGoGame:        [12, 14, 20, 32],           // NEW — right stopping network
  trailsGame:        [7, 8, 59, 60, 31, 32],     // NEW — frontoparietal set-shifting
};

// Union of every AAL index that can appear as a node (fixed node set) — now
// includes the deep grey-matter structures + resting-state-network hubs for the
// high-density connectome. All still render as simple additive spheres.
const _ALL_NODE_AAL = Array.from(new Set([
  ...Object.values(CONNECTOME_DATABASE).flatMap(t => t.tracts.flatMap(tr => tr.aalRegions ?? [])),
  ...Object.values(COGNITIVE_REGION_AAL).flat(),
  ...DEEP_NODES,
  ...Object.values(RS_NETWORKS).flatMap(n => n.nodes),
])).filter(idx => AAL_CENTROID_MNI[idx] != null).sort((a, b) => a - b);

// Per-tract camera orientation for the cinematic tour [azimuth°, elevation°].
const TOUR_ANGLES = {
  fornix:[180,30], cingulum:[265,22], arcuate:[110,18], slf2:[110,35],
  fat:[110,25], frontalLocal:[105,28], uf:[110,-10], cst:[240,20],
  stoppingRight:[60,20], setShifting:[110,30],
};
const TOUR_DEFAULT = [235, 14];

// ─── Colour system (holographic) ──────────────────────────────────────────────
// Lobe base hues (resting nodes), tuned cool for the hologram aesthetic.
const LOBE_HEX = {
  other:0x6b7a90, frontal:0x3f7fd6, parietal:0x9b4bd0, temporal:0x27c08a,
  occipital:0xd88a2e, cingulate:0x7a6bd6, hippocampus:0xd0a24a,
  amygdala:0xd05a9e, subcortical:0x6f8fb0, cerebellum:0x8a7fb0,
};
const CLR_DEFICIT   = 0xff4b30;   // hot red    — predicted deficit / hypo-connectivity
const CLR_HYPER     = 0xc95aff;   // violet     — modelled hyper-connectivity
const CLR_HIGHLIGHT = 0x5ad2ff;   // cyan       — active cognitive region (gameplay)
const CLR_NORMAL    = 0x39d0c8;   // teal       — resting / normal tract
const CLR_UNTESTED  = 0x4a5a70;   // slate       — pathway with no data yet
const CLR_SHELL     = 0x63b9ff;   // glass rim tint

// Max deficit "variance points" fed to the gray-matter erosion shader (§4).
const MAXDEF = 16;

// Cognitive domains for the Z-score radar (§3). Each maps to one or more test
// keys; a domain's score is the mean sign-corrected Z (zc) of its tested members.
const DOMAINS = [
  { label: 'Working Mem.',   tests: ['nback'] },
  { label: 'Executive',      tests: ['stroop'] },
  { label: 'Flexibility',    tests: ['trailsB'] },
  { label: 'Inhibition',     tests: ['goNoGo'] },
  { label: 'Motor Speed',    tests: ['fingerTapping'] },
  { label: 'Lexical Retr.',  tests: ['verbalFluency'] },
  { label: 'Visuospatial',   tests: ['corsi'] },
  { label: 'Language',       tests: ['rsvp'] },
];

function _classifyLobe(name) {
  if (/Cingul/i.test(name))                                   return 'cingulate';
  if (/Hippocampus|ParaHippocampal/i.test(name))              return 'hippocampus';
  if (/Amygdala/i.test(name))                                 return 'amygdala';
  if (/Frontal|Precentral|Supp_Motor|Rectus|Olfactory|Rolandic/i.test(name)) return 'frontal';
  if (/Parietal|Postcentral|Precuneus|SupraMarginal|Angular/i.test(name))     return 'parietal';
  if (/Temporal|Heschl|Fusiform/i.test(name))                 return 'temporal';
  if (/Occipital|Calcarine|Cuneus|Lingual/i.test(name))       return 'occipital';
  if (/Thalamus|Caudate|Putamen|Pallidum|Insula/i.test(name)) return 'subcortical';
  if (/Cerebel|Vermis/i.test(name))                           return 'cerebellum';
  return 'other';
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOM SCAFFOLD (loading text · debug log · crash card · WebGL preflight)
// ═══════════════════════════════════════════════════════════════════════════════
const canvas = document.getElementById('niivue-gl'); // id kept for index.html compat

const loadingEl = document.createElement('div');
loadingEl.style.cssText = [
  'position:fixed','top:50%','left:50%','transform:translate(-50%,-50%)',
  'color:rgba(180,210,255,0.85)','font-family:Inter,system-ui,sans-serif',
  'font-size:13px','font-weight:500','letter-spacing:0.08em','z-index:20',
  'pointer-events:none','text-align:center','text-shadow:0 1px 4px rgba(0,0,0,0.8)',
].join(';');
document.body.appendChild(loadingEl);
const setLoadingText = t => { loadingEl.textContent = t ?? ''; loadingEl.style.display = t ? 'block' : 'none'; };

// On-screen boot/status log — opt-in via ?debug in the URL so it doesn't sit on
// top of the UI (highest z-index in the app) during normal use. Always still
// logs to the browser console either way.
const _dbgVisible = new URLSearchParams(location.search).has('debug');
let _dbgEl = null;
if (_dbgVisible) {
  _dbgEl = document.createElement('div');
  _dbgEl.id = 'brain-dbg';
  _dbgEl.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:999;font:10px/1.6 monospace;' +
    'color:#7af;background:rgba(0,0,0,.75);padding:6px 10px;border-radius:6px;max-width:360px;' +
    'white-space:pre-wrap;pointer-events:none;max-height:180px;overflow-y:auto;';
  document.body.appendChild(_dbgEl);
}
function _dbg(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  if (_dbgEl) {
    _dbgEl.textContent += `[${ts}] ${msg}\n`;
    _dbgEl.scrollTop = _dbgEl.scrollHeight;
  }
  console.log('[Brain Trainer]', msg);
}

function _showGPUCrashCard() {
  if (document.getElementById('gpu-crash-card')) return;
  const overlay = document.createElement('div');
  overlay.id = 'gpu-crash-card';
  overlay.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'background:#0d1424;z-index:500;font-family:Inter,system-ui,sans-serif;padding:24px;';
  overlay.innerHTML = `
    <div style="background:#1a2540;border:1px solid #2a4080;border-radius:18px;max-width:480px;width:100%;padding:36px 40px;text-align:center;color:#c8d8f0;">
      <div style="font-size:40px;margin-bottom:16px;">🧠</div>
      <h2 style="font-size:18px;font-weight:700;color:#fff;margin:0 0 12px;">3D viewer paused</h2>
      <p style="font-size:13px;color:#8aabcf;line-height:1.7;margin:0 0 20px;">
        The graphics context was lost (usually a GPU driver hiccup or hardware
        acceleration being disabled). Your test data is safe.</p>
      <div style="background:#0d1424;border-radius:10px;padding:16px;text-align:left;font-size:12px;color:#7aacdd;line-height:1.9;">
        <b style="color:#aad4ff">Chrome / Edge:</b> Settings → System → turn ON
        <em>"Use hardware acceleration"</em> → Relaunch.<br>
        <b style="color:#aad4ff">Check:</b> <code style="color:#7af">chrome://gpu</code> → WebGL "Hardware accelerated".<br>
        <b style="color:#aad4ff">Or reload the page.</b></div>
    </div>`;
  document.body.appendChild(overlay);
}

(function webglPreflight() {
  try {
    const t = document.createElement('canvas');
    const gl = t.getContext('webgl2') || t.getContext('webgl');
    if (gl) _dbg(`WebGL OK (${gl.getParameter(gl.VERSION)})`);
    else { _dbg('WebGL UNAVAILABLE'); _showGPUCrashCard(); }
  } catch (e) { _dbg('WebGL check error: ' + e.message); }
})();

function _safe(fn) { try { return fn(); } catch (e) { console.warn('[Brain Trainer] call failed:', e); } }

// ═══════════════════════════════════════════════════════════════════════════════
// ENGINE STATE
// ═══════════════════════════════════════════════════════════════════════════════
let THREE = null;
let _renderer = null, _scene = null, _camera = null;
let _brainGroup = null;      // holds shell + tracts + nodes; rotated for tour/idle
let _shellMat = null;        // holographic glass shader (Functional Hologram mode)
let _shellMatAnat = null;    // greyscale/X-ray shader (Anatomical Scan mode)
let _shellMesh = null;       // the cortex Mesh whose .material the Mode Manager swaps
let _shellGeo = null;        // its BufferGeometry (holds the optional aAtrophy attribute)
let _viewMode = 'hologram';  // 'hologram' | 'anatomical'
let _atrophyLoaded = false;
let _gridRing = null;
let _raycaster = null;       // node/tract picking (works in BOTH view modes)

let _ready = false;
let _aalLabels = [];         // AAL name per index (fetched for lobe classification)
let _nodes = [];             // [{ idx, core, halo, baseHex, pos }]
let _tracts = [];            // [{ key, tract, testKey, tube, mat, flowTex, from, to, curve }]
let _netEdges = [];          // resting-state / basal-ganglia network tubes (static)
let _lesions = [];           // surgical-planning lesion spheres
let _surgicalMode = false;   // click-to-drop-lesion mode
let _progress = 0;           // 4D longitudinal progression 0 (today) … 1 (+5 yr) — smoothed, rendered value
let _progressTarget = 0;     // slider's raw target; _progress eases toward this each frame
let _paused = false;         // true while the NiiVue importer owns the WebGL context
let _nvReal = null;          // on-demand NiiVue instance (never coexists with Three.js render)
let _nvCanvas = null;

let _deficitIdx   = new Set();
let _hyperIdx     = new Set();
let _highlightIdx = new Set();
let _twinScores   = null;
let _baselineMode = false;
let _tourMode     = false;   // X-ray: shell fades, resting nodes dim

// ── Live in-task feedback (per-node, decays each frame) ─────────────────────
// Purely cosmetic real-time response to gameplay events — e.g. a pathway
// visibly "warming up" tap by tap during Finger Tapping, or a brief flicker
// suggesting momentary strain right after a wrong memory-test answer. Kept
// separate from _highlightIdx/_deficitIdx so it never touches the actual
// clinical deficit/hyper state — it's additive flavor on top, not data.
// Lazily instantiated once THREE is loaded (see _scratchColor use in _loop).
let _scratchColor = null, _scratchColor2 = null;

// ── mm → scene-space fitting ────────────────────────────────────────────────
// The MNI centroid cloud (connectome_database.js → AAL_CENTROID_MNI) is
// normalised by its OWN bounding box, then mapped onto the brain_mesh.obj local
// axes. Orientation was determined empirically from the mesh geometry:
//   mesh local X (±85, longest) = ANTERIOR–POSTERIOR
//   mesh local Y (±76)          = SUPERIOR–INFERIOR  (brainstem at −Y)
//   mesh local Z (±69)          = LEFT–RIGHT
// (The previous build mapped MNI L/R onto mesh X and A/P onto mesh Z — i.e. the
// two horizontal axes were swapped, so the whole network read rotated 90°. Fixed.)
let _meshCenter = null, _meshHalf = null;
let _mniCenter  = [0, 0, 0];   // centre of the node cloud in MNI mm (set at load)
let _mniHalf    = [1, 1, 1];   // half-extent of the node cloud in MNI mm (set at load)

// Fraction of the shell half-extent the node cloud fills on each ANATOMICAL axis.
// `is` is deliberately small: the mesh's Y half-extent includes the narrow
// brainstem tail (dead space), so the cerebral node cloud only occupies the
// upper band — hence a smaller vertical fill plus a positive yOffset to lift it
// off the brainstem and onto the cerebrum.
const NODE_FIT  = { ap: 0.82, is: 0.58, lr: 0.80 };
// Flip an axis if anterior/posterior or left/right ever reads mirrored.
const NODE_SIGN = { ap: -1, is: +1, lr: +1 };
// ── Manual alignment nudges (scene units) ───────────────────────────────────
// Slide the ENTIRE node/tract network to fit it precisely inside the glass shell.
// Positive directions:  xOffset → posterior · yOffset → superior · zOffset → +Z hemisphere.
const xOffset = -6;   // ease posterior nodes off the occipital edge
const yOffset = 18;   // lift the cloud onto the cerebrum (off the brainstem tail)
const zOffset = 0;

// ─── Cinematic tour ───────────────────────────────────────────────────────────
let _cinematic = null, _rafId = null, _lastT = 0;
let _idleSpin = true, _dragging = false;
let _spinVelY = 0;           // residual angular velocity (rad/frame) after a drag release — decays into idle spin
let _camDistTarget = null;   // wheel-zoom target distance; camera eases toward it each frame

// ═══════════════════════════════════════════════════════════════════════════════
// COORDINATE MAPPING
// MNI(mm) → scene. Neuro convention → graphics Y-up:  x→x (L/R),  z(sup/inf)→y,
// y(ant/post)→z. Signs tuned so nodes nest inside the loaded shell. This is a
// deliberate visual fit, not a registered anatomical overlay.
// ═══════════════════════════════════════════════════════════════════════════════
// Derive the MNI cloud centre/half-extent from the exact set of nodes we place,
// so the cloud fills the shell regardless of the nominal MNI bounding box.
function _computeMniBounds() {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const idx of _ALL_NODE_AAL) {
    const c = AAL_CENTROID_MNI[idx]; if (!c) continue;
    for (let k = 0; k < 3; k++) { if (c[k] < mn[k]) mn[k] = c[k]; if (c[k] > mx[k]) mx[k] = c[k]; }
  }
  if (!Number.isFinite(mn[0])) return;   // no centroids — keep defaults
  _mniCenter = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  _mniHalf   = [Math.max(1, (mx[0] - mn[0]) / 2), Math.max(1, (mx[1] - mn[1]) / 2), Math.max(1, (mx[2] - mn[2]) / 2)];
}

function _mniToScene(mni) {
  const nx = (mni[0] - _mniCenter[0]) / _mniHalf[0];   // + = right     (L/R)
  const ny = (mni[1] - _mniCenter[1]) / _mniHalf[1];   // + = anterior  (A/P)
  const nz = (mni[2] - _mniCenter[2]) / _mniHalf[2];   // + = superior  (I/S)
  return new THREE.Vector3(
    _meshCenter.x + NODE_SIGN.ap * ny * _meshHalf.x * NODE_FIT.ap + xOffset,  // mesh X = A/P
    _meshCenter.y + NODE_SIGN.is * nz * _meshHalf.y * NODE_FIT.is + yOffset,  // mesh Y = I/S
    _meshCenter.z + NODE_SIGN.lr * nx * _meshHalf.z * NODE_FIT.lr + zOffset,  // mesh Z = L/R
  );
}
function _regionCentroidScene(regionKey) {
  const ids = (REGION_TO_AAL[regionKey] ?? []).filter(i => AAL_CENTROID_MNI[i]);
  if (!ids.length) return null;
  const acc = [0, 0, 0];
  ids.forEach(i => { const c = AAL_CENTROID_MNI[i]; acc[0]+=c[0]; acc[1]+=c[1]; acc[2]+=c[2]; });
  return _mniToScene(acc.map(v => v / ids.length));
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEXTURES (generated procedurally — no external image assets)
// ═══════════════════════════════════════════════════════════════════════════════
function _makeHaloTexture() {
  const s = 128, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c); tex.needsUpdate = true; return tex;
}
// Tight, bright inner glow — layered under the soft outer halo above so each node
// reads as a glowing point of light rather than a flat, hard-edged colored disc.
function _makeCoreGlowTexture() {
  const s = 64, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
  grd.addColorStop(0,    'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.65, 'rgba(255,255,255,0.22)');
  grd.addColorStop(1,    'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c); tex.needsUpdate = true; return tex;
}
function _makeFlowTexture() {
  // "Action-potential" pulse train: two bright spikes with sharp leading heads and
  // long comet tails on a faint baseline, scrolled along the tube for firing flow.
  const w = 256, h = 8, c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const spikes = [0.30, 0.80];
  for (let x = 0; x < w; x++) {
    const u = x / w;
    let v = 0.05;                                   // faint baseline keeps the tract path readable
    for (const s of spikes) {
      let d = u - s; if (d > 0.5) d -= 1; if (d < -0.5) d += 1;
      v += d >= 0 ? Math.exp(-d / 0.012)            // sharp leading head
                  : Math.exp( d / 0.11);            // long trailing comet tail
    }
    v = Math.min(1, v);
    const a = Math.round(v * 255);
    for (let y = 0; y < h; y++) { const i = (y * w + x) * 4; img.data[i]=255; img.data[i+1]=255; img.data[i+2]=255; img.data[i+3]=a; }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(2.5, 1); tex.needsUpdate = true; return tex;
}
let _haloTex = null;
let _coreGlowTex = null;

// ═══════════════════════════════════════════════════════════════════════════════
// GLASS SHELL SHADER — cheap unlit Fresnel rim + faint animated scan
// ═══════════════════════════════════════════════════════════════════════════════
function _makeShellMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uColor:     { value: new THREE.Color(CLR_SHELL) },
      uTime:      { value: 0 },
      uPower:     { value: 2.4 },
      uOpacity:   { value: 0.55 },
      // §4 dynamic gray-matter variance — deficit lobes erode/desaturate.
      uDefCount:  { value: 0 },
      uDefRadius: { value: 60 },
      uDef:       { value: Array.from({ length: MAXDEF }, () => new THREE.Vector3()) },
      uErode:     { value: 0.45 },   // gentle — see the scientifically-scaled atrophy note below
      uProgress:  { value: 0 },      // §4D longitudinal progression 0…1 (today → +5 yr)
    },
    vertexShader: `
      varying vec3 vN; varying vec3 vV; varying float vY; varying vec3 vLocal;
      void main(){
        vec4 wp = modelMatrix * vec4(position,1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        vY = position.y; vLocal = position;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uTime, uPower, uOpacity, uDefRadius, uErode, uProgress;
      uniform int uDefCount; uniform vec3 uDef[${MAXDEF}];
      varying vec3 vN; varying vec3 vV; varying float vY; varying vec3 vLocal;
      float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      void main(){
        float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), uPower);
        float scan = 0.5 + 0.5 * sin(vY * 0.08 - uTime * 1.6);

        // How structurally "degraded" is this fragment's lobe? (nearest deficit focus)
        float degrade = 0.0;
        for (int i = 0; i < ${MAXDEF}; i++) {
          if (i >= uDefCount) break;
          float d = distance(vLocal, uDef[i]);
          degrade = max(degrade, 1.0 - smoothstep(uDefRadius * 0.35, uDefRadius, d));
        }

        // §4D longitudinal progression: deepen focal deficits and add mild global
        // aging as the clinician slides into the future (drives real-time erosion).
        degrade = min(1.0, degrade * (1.0 + uProgress * 1.8) + uProgress * 0.12);

        // Scientifically-scaled atrophy: realistic regional GM loss is modest
        // (~10-25% even in impairment), so deficit tissue mainly DARKENS + thins
        // subtly. Only the most severe core (degrade > 0.55) shows faint surface
        // breakup — no exaggerated moth-eaten holes.
        float n = hash(vLocal * 0.07) * 0.6 + hash(vLocal * 0.15 + 5.0) * 0.4;
        if (degrade > 0.55 && n < (degrade - 0.55) * uErode) discard;

        vec3 col = uColor * (0.6 + fres);
        float luma = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(col, vec3(luma) * 0.60, degrade * 0.70);   // desaturate + gently darken deficit tissue
        col *= 1.0 + (1.0 - degrade) * 0.10;                  // dense, healthy tissue reads a touch brighter

        float a = uOpacity * (0.18 + fres * 1.1) * (0.75 + 0.25 * scan);
        a *= mix(1.0, 0.62, degrade);                         // deficit lobes thin subtly (~≤40%)
        gl_FragColor = vec4(col, a);
      }`,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANATOMICAL SCAN SHADER — greyscale / X-ray T1-MRI-style shading (Mode Manager)
// The holographic shader above is preserved untouched; this is a SEPARATE material
// the Mode Manager swaps in. Translucent greyscale so the functional connectome
// nodes/tracts still read through the shell ("structural density vs functional
// deficit"). Optional per-vertex `aAtrophy` density (0=atrophied → 1=dense) is
// colour-mapped onto the surface when an atrophy-data file is supplied.
// ═══════════════════════════════════════════════════════════════════════════════
function _makeAnatomicalMaterial() {
  return new THREE.ShaderMaterial({
    // FrontSide (not DoubleSide): avoids order-dependent front/back blending artifacts
    // on a translucent closed mesh, giving a clean scan surface. Still see-through so
    // the functional connectome reads underneath.
    transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    side: THREE.FrontSide,
    uniforms: {
      uOpacity:    { value: 0.68 },
      uContrast:   { value: 1.35 },
      uLightDir:   { value: new THREE.Vector3(0.4, 0.7, 0.9).normalize() },
      uHasAtrophy: { value: 0.0 },
    },
    vertexShader: `
      attribute float aAtrophy;
      varying vec3 vN; varying vec3 vV; varying float vAtrophy;
      void main(){
        vec4 wp = modelMatrix * vec4(position,1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        vAtrophy = aAtrophy;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform float uOpacity, uContrast, uHasAtrophy;
      uniform vec3 uLightDir;
      varying vec3 vN; varying vec3 vV; varying float vAtrophy;
      void main(){
        vec3 N = normalize(vN);
        float ndv = abs(dot(N, normalize(vV)));
        // Soft wrap-lambert body shade + bright tissue-boundary rim (X-ray look).
        float diff = clamp(dot(N, normalize(uLightDir)) * 0.5 + 0.5, 0.0, 1.0);
        float rim  = pow(1.0 - ndv, 1.5);
        // Grey-matter cortex base; broad viewer-facing gyral crowns read a touch
        // brighter (a nod to the underlying white matter), grazing folds darker.
        float g = diff * 0.70 + 0.13 + rim * 0.40 + smoothstep(0.6, 1.0, ndv) * 0.10;
        g = clamp(pow(g, uContrast), 0.0, 1.0);
        vec3 col = vec3(g * 0.98, g, g * 1.02);   // faintly cool tissue grey
        // Structural-density map — calibrated, NOT exaggerated. Atrophied cortex
        // reads slightly darker (volume/thickness loss) with a faint warm tint;
        // healthy tissue stays neutral-cool. Loss maxes ~25% per atrophy.json.
        if (uHasAtrophy > 0.5) {
          float loss = 1.0 - clamp(vAtrophy, 0.0, 1.0);
          col *= (1.0 - loss * 0.9);
          col = mix(col, col * vec3(1.18, 0.86, 0.70), clamp(loss * 1.8, 0.0, 0.6));
        }
        gl_FragColor = vec4(col, uOpacity);
      }`,
  });
}

// Load an optional atrophy-data file and paint per-vertex density onto the shell.
// Accepts EITHER a flat array (length == vertex count, values 0..1) OR a compact
// region map { "regions": { "<AAL idx>": density } } that is diffused over the
// surface via a Gaussian around each region's centroid. Missing file → plain grey.
async function _loadAtrophy() {
  if (!_shellGeo || !_shellMatAnat) return;
  try {
    const res = await fetch('./atrophy.json');
    if (!res.ok) return;
    const data = await res.json();
    const N = _shellGeo.attributes.position.count;
    const attr = _shellGeo.getAttribute('aAtrophy');
    if (!attr) return;

    if (Array.isArray(data) && data.length === N) {
      for (let i = 0; i < N; i++) attr.array[i] = Math.max(0, Math.min(1, data[i]));
    } else if (data && data.regions) {
      const pos = _shellGeo.attributes.position.array;
      const radius = _meshHalf.length() * 0.24;
      const twoR2 = 2 * radius * radius;
      const foci = Object.entries(data.regions)
        .map(([k, v]) => ({ p: AAL_CENTROID_MNI[+k] ? _mniToScene(AAL_CENTROID_MNI[+k]) : null, d: Math.max(0, Math.min(1, v)) }))
        .filter(e => e.p);
      for (let i = 0; i < N; i++) {
        const x = pos[i*3], y = pos[i*3+1], z = pos[i*3+2];
        let m = 1.0;
        for (const e of foci) {
          const dx = x - e.p.x, dy = y - e.p.y, dz = z - e.p.z;
          const f = Math.exp(-(dx*dx + dy*dy + dz*dz) / twoR2);
          m = Math.min(m, 1 - (1 - e.d) * f);
        }
        attr.array[i] = m;
      }
    } else { return; }

    attr.needsUpdate = true;
    _shellMatAnat.uniforms.uHasAtrophy.value = 1.0;
    _atrophyLoaded = true;
    _dbg('atrophy map applied (structural density colour-map active)');
  } catch (_) { /* no atrophy file → clean greyscale scan */ }
}

// ── MODE MANAGER ────────────────────────────────────────────────────────────
// Swaps the shell material + scene chrome between the two views. Everything else
// (nodes, tracts, radar, HUD, raycast picking) is shared, so both modes stay fully
// interactive. The holographic material/state is never destroyed — only detached.
function _setViewMode(mode) {
  mode = (mode === 'anatomical') ? 'anatomical' : 'hologram';
  _viewMode = mode;
  if (!_shellMesh || !_ready) return;
  if (mode === 'anatomical') {
    _shellMesh.material = _shellMatAnat;
    _safe(() => { _scene.background.setHex(0x0a0e14); if (_scene.fog) _scene.fog.color.setHex(0x0a0e14); });
    if (_gridRing) _gridRing.visible = false;
  } else {
    _shellMesh.material = _shellMat;
    _safe(() => { _scene.background.setHex(0x060a12); if (_scene.fog) _scene.fog.color.setHex(0x060a12); });
    if (_gridRing) _gridRing.visible = true;
  }
  _refreshTracts();                 // re-style tracts (neon vs white-matter) for the mode
  _safe(() => _renderer.render(_scene, _camera));
}

// ═══════════════════════════════════════════════════════════════════════════════
// GEOMETRY BUILD
// ═══════════════════════════════════════════════════════════════════════════════
function _parseOBJ(text) {
  const pos = [], idx = [];
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.charCodeAt(0) === 118 && line[1] === ' ') {       // 'v '
      const p = line.split(/\s+/);
      pos.push(+p[1], +p[2], +p[3]);
    } else if (line.charCodeAt(0) === 102 && line[1] === ' ') { // 'f '
      const p = line.trim().split(/\s+/);
      const a = parseInt(p[1], 10) - 1, b = parseInt(p[2], 10) - 1, c = parseInt(p[3], 10) - 1;
      idx.push(a, b, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  return geo;
}

// Small, discrete deep-brain / limbic structures render smaller than broad cortical
// lobar regions — a rough anatomical-scale cue instead of one uniform node size for
// everything from the thalamus to the entire frontal lobe.
const SMALL_STRUCTURE_LOBES = new Set(['hippocampus', 'amygdala']);
function _nodeBaseScale(idx, lobe) {
  return (DEEP_NODES.includes(idx) || SMALL_STRUCTURE_LOBES.has(lobe)) ? 8 : 11;
}

function _buildNodes() {
  _haloTex = _makeHaloTexture();
  _coreGlowTex = _makeCoreGlowTexture();
  const coreGeo = new THREE.IcosahedronGeometry(2.4, 1);
  for (const idx of _ALL_NODE_AAL) {
    const pos = _mniToScene(AAL_CENTROID_MNI[idx]);
    const lobe = _classifyLobe(_aalLabels[idx] || '');
    const baseHex = LOBE_HEX[lobe] ?? LOBE_HEX.other;
    const baseScale = _nodeBaseScale(idx, lobe);

    // Invisible hit-target for raycasting only — Three.js hit-tests mesh geometry
    // regardless of material opacity, so this stays fully transparent while the
    // two glow sprites below carry 100% of the visible look. depthWrite must stay
    // off, or this invisible mesh still punches an opaque hole in the depth buffer
    // and occludes the glow sprites (and shell) behind it.
    const core = new THREE.Mesh(
      coreGeo,
      new THREE.MeshBasicMaterial({ color: baseHex, transparent: true, opacity: 0, depthWrite: false }),
    );
    core.position.copy(pos);

    // Bright, tight inner glow — a hot point of light instead of a flat solid disc.
    const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: _coreGlowTex, color: baseHex, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    coreGlow.position.copy(pos); coreGlow.scale.setScalar(baseScale * 0.42);

    // Soft, wide ambient glow around the bright core.
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: _haloTex, color: baseHex, transparent: true, opacity: 0.75,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    halo.position.copy(pos); halo.scale.setScalar(baseScale);

    const node = { idx, core, coreGlow, halo, baseHex, pos, baseScale };
    core.userData.node = node; halo.userData.node = node;   // for raycast picking
    _brainGroup.add(core); _brainGroup.add(coreGlow); _brainGroup.add(halo);
    _nodes.push(node);
  }
}

function _buildTracts() {
  Object.entries(CONNECTOME_DATABASE).forEach(([testKey, testDef]) => {
    testDef.tracts.forEach(tract => {
      const a = _regionCentroidScene(tract.from);
      const b = _regionCentroidScene(tract.to);
      if (!a || !b) return;
      // Lift the control point outward for a graceful arc.
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const out = mid.clone().sub(_meshCenter).normalize().multiplyScalar(_meshHalf.length() * 0.10);
      mid.add(out).add(new THREE.Vector3(0, _meshHalf.y * 0.10, 0));
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);

      const flowTex = _makeFlowTexture();
      const tubeGeo = new THREE.TubeGeometry(curve, 64, 1.7, 8, false);
      const mat = new THREE.MeshBasicMaterial({
        map: flowTex, color: CLR_UNTESTED, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      });
      const tube = new THREE.Mesh(tubeGeo, mat);
      _brainGroup.add(tube);
      _tracts.push({ key: tract.key, tract, testKey, tube, mat, flowTex, from: a, to: b, curve,
        speed: 0.2, baseOpacity: 0.5, pulseFreq: 3, pulseAmp: 0.2 });
    });
  });
}

// Thin, static, network-coloured tubes for the resting-state / basal-ganglia graph.
function _buildNetworkEdges() {
  for (const e of NETWORK_EDGES) {
    const a = AAL_CENTROID_MNI[e.a] ? _mniToScene(AAL_CENTROID_MNI[e.a]) : null;
    const b = AAL_CENTROID_MNI[e.b] ? _mniToScene(AAL_CENTROID_MNI[e.b]) : null;
    if (!a || !b) continue;
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.add(mid.clone().sub(_meshCenter).normalize().multiplyScalar(_meshHalf.length() * 0.04));
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const col = RS_NETWORKS[e.net]?.color ?? 0x8899bb;
    const mat = new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.26,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.6, 5, false), mat);
    _brainGroup.add(tube);
    _netEdges.push({ net: e.net, tube, mat, curve });
  }
}

function _buildGridRing() {
  const r = _meshHalf.length() * 0.95;
  const g = new THREE.RingGeometry(r * 0.98, r, 96);
  const m = new THREE.MeshBasicMaterial({
    color: 0x2a5a8a, transparent: true, opacity: 0.35, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  _gridRing = new THREE.Mesh(g, m);
  _gridRing.rotation.x = Math.PI / 2;
  _gridRing.position.y = -_meshHalf.y * 1.15;
  _brainGroup.add(_gridRing);
}

// ═══════════════════════════════════════════════════════════════════════════════
// VISUAL STATE — recolour nodes + tracts from the deficit/hyper/highlight sets
// ═══════════════════════════════════════════════════════════════════════════════
function _nodeState(idx) {
  if (!_baselineMode && _deficitIdx.has(idx)) return { hex: CLR_DEFICIT, glow: 1.5, active: true };
  if (!_baselineMode && _hyperIdx.has(idx))   return { hex: CLR_HYPER,   glow: 1.4, active: true };
  if (_highlightIdx.has(idx))                 return { hex: CLR_HIGHLIGHT, glow: 1.5, active: true };
  return { hex: null, glow: _tourMode ? 0.0 : 0.7, active: false };
}
function _refreshNodes() {
  for (const n of _nodes) {
    const s = _nodeState(n.idx);
    const hex = s.hex ?? n.baseHex;
    // n.core stays permanently invisible (opacity 0, set once at creation) — it
    // exists purely as a raycast hit-target. All visible glow lives on coreGlow/halo.
    n.coreGlow.material.color.setHex(hex);
    n.coreGlow.material.opacity = s.active ? 1.0 : (_tourMode ? 0.12 : 0.85);
    n.halo.material.color.setHex(hex);
    n.halo.material.opacity = s.glow * (s.active ? 0.95 : 0.55);
    n._targetScale = s.active ? n.baseScale * 1.36 : n.baseScale;   // animated toward in the loop
    n._pulse = s.active;
  }
}
function _tractStatus(t) {
  if (_baselineMode) return 'reference';
  const v = _twinScores?.[t.testKey] ?? null;
  if (v == null) return 'untested';
  return t.tract.getStatus ? t.tract.getStatus(v) : 'reference';
}
function _refreshTracts() {
  // Per status: [colour, baseOpacity, scrollSpeed, pulse repeats, pulseFreq, pulseAmp, brightnessMul]
  // Deficit → slow, weak, dim pulse.  Hyper → rapid, blazing.  (§2)
  for (const t of _tracts) {
    const st = _tractStatus(t);
    let hex = CLR_NORMAL, op = 0.55, speed = 0.35, rep = 2.5, pf = 3.0, pa = 0.20, mul = 1.0;
    if      (st === 'deficit')  { hex = CLR_DEFICIT;  op = 0.85; speed = 0.06; rep = 1.5; pf = 1.1; pa = 0.45; mul = 0.7; }
    else if (st === 'hyper')    { hex = CLR_HYPER;    op = 1.00; speed = 1.20; rep = 4.5; pf = 7.0; pa = 0.10; mul = 1.0; }
    else if (st === 'untested') { hex = CLR_UNTESTED; op = 0.24; speed = 0.03; rep = 1.0; pf = 0.6; pa = 0.10; mul = 1.0; }
    // active gameplay highlight bumps any tract touching a highlighted node
    const touchesActive = (REGION_TO_AAL[t.tract.from] ?? []).some(i => _highlightIdx.has(i)) ||
                          (REGION_TO_AAL[t.tract.to]   ?? []).some(i => _highlightIdx.has(i));
    if (touchesActive) { hex = CLR_HIGHLIGHT; op = 0.95; speed = 0.85; rep = 3.5; pf = 5.0; pa = 0.15; mul = 1.0; }

    const dim = _tourMode && st !== 'deficit' && st !== 'hyper' && !touchesActive;
    if (_viewMode === 'anatomical') {
      // Anatomical Scan: tracts read as white-matter fibre bundles — a cream base,
      // tinted toward the status colour so pathology (deficit red / hyper violet)
      // still stands out against the greyscale cortex.
      const salient = (st === 'deficit' || st === 'hyper' || touchesActive);
      t.mat.color.setHex(0xEAE2D0).lerp(new THREE.Color(hex), salient ? 0.6 : 0.18);
      t.baseOpacity = dim ? Math.max(0.35, op) : Math.max(0.72, op);
    } else {
      t.mat.color.setHex(hex); t.mat.color.multiplyScalar(mul);
      t.baseOpacity = dim ? op * 0.22 : op;
    }
    t.flowTex.repeat.x = rep;
    t.speed = speed; t.pulseFreq = pf; t.pulseAmp = pa;
  }
}
function _updateGrayMatterVariance() {
  if (!_shellMat) return;
  const u = _shellMat.uniforms;
  const pts = [];
  if (!_baselineMode) {
    for (const idx of _deficitIdx) {
      const c = AAL_CENTROID_MNI[idx]; if (!c) continue;
      pts.push(_mniToScene(c));
      if (pts.length >= MAXDEF) break;
    }
  }
  for (let i = 0; i < MAXDEF; i++) {
    if (pts[i]) u.uDef.value[i].copy(pts[i]);
    else u.uDef.value[i].set(0, 0, 0);
  }
  u.uDefCount.value = pts.length;
}
function _refreshAll() { _refreshNodes(); _refreshTracts(); _updateGrayMatterVariance(); }

// ═══════════════════════════════════════════════════════════════════════════════
// CAMERA / ORIENTATION
// ═══════════════════════════════════════════════════════════════════════════════
function _applyOrientation(az, el) {
  if (!_brainGroup) return;
  _brainGroup.rotation.y = THREE.MathUtils.degToRad(az - 180);
  _brainGroup.rotation.x = THREE.MathUtils.degToRad(el);
}
const _smoothstep = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

// ═══════════════════════════════════════════════════════════════════════════════
// RENDER LOOP  (single rAF; pauses when hidden)
// ═══════════════════════════════════════════════════════════════════════════════
function _loop(now) {
  if (_paused) { _rafId = null; return; }   // NiiVue owns the GPU — fully stop the Three.js loop
  _rafId = requestAnimationFrame(_loop);
  if (document.hidden) return;
  const dt = Math.min((now - _lastT) / 1000, 0.05); _lastT = now;
  const t = now / 1000;

  if (_shellMat) {
    _shellMat.uniforms.uTime.value = t;
    // Ease the longitudinal-progression slider toward its target instead of
    // snapping, so scrubbing/clicking the timeline reads as a smooth transition.
    if (Math.abs(_progressTarget - _progress) > 0.0005) {
      _progress += (_progressTarget - _progress) * Math.min(1, dt * 3);
    } else {
      _progress = _progressTarget;
    }
    _shellMat.uniforms.uProgress.value = _progress;
  }
  for (const tr of _tracts) {
    tr.flowTex.offset.x -= (tr.speed ?? 0.2) * dt;
    const amp = tr.pulseAmp ?? 0;
    const env = (1 - amp) + amp * (0.5 + 0.5 * Math.sin(t * (tr.pulseFreq ?? 0)));
    tr.mat.opacity = (tr.baseOpacity ?? 0.5) * env;   // deficit=slow/weak, hyper=fast/blazing
  }

  // node pulse + halo/coreGlow scale easing
  if (!_scratchColor && _nodes.length) { _scratchColor = new THREE.Color(); _scratchColor2 = new THREE.Color(); }
  for (const n of _nodes) {
    const pulse = n._pulse ? 1 + 0.18 * Math.sin(t * 4 + n.idx) : 1;
    // Subtle idle "breathing" on every node (not just active ones) so the whole
    // field reads as alive rather than a static field of stickers — much gentler
    // than the active-node pulse above.
    const idleBreath = n._pulse ? 1 : 1 + 0.05 * Math.sin(t * 0.9 + n.idx * 1.7);
    let target = (n._targetScale ?? n.baseScale ?? 11) * pulse * idleBreath;

    // Live gameplay feedback: tap/answer-driven "energy" pop, decaying each frame.
    // Boosts size, opacity, AND tints toward the highlight cyan — a pure scale bump is
    // nearly invisible on a small, dim, already-blue resting node against the hologram.
    if (n._energy) {
      target += n._energy * 7;
      const k = Math.min(1, n._energy);
      _scratchColor.setHex(n.baseHex).lerp(_scratchColor2.setHex(CLR_HIGHLIGHT), k);
      n.halo.material.color.copy(_scratchColor);
      n.coreGlow.material.color.copy(_scratchColor);
      n.halo.material.opacity = Math.min(1.4, 0.6 + n._energy * 0.6);
      n.coreGlow.material.opacity = Math.min(1.4, 0.85 + n._energy * 0.4);
      n._energyWasActive = true;
      n._energy *= Math.pow(0.06, dt);   // fast-ish decay — a burst of taps keeps it topped up
      if (n._energy < 0.01) n._energy = 0;
    } else if (n._energyWasActive) {
      n._energyWasActive = false;
      _refreshNodes();   // restore true color/opacity/state now the pop has fully faded
    }

    // Brief "atrophy" flicker right after a wrong answer — a cosmetic dip, not clinical data.
    if (n._atrophyUntil) {
      if (now < n._atrophyUntil) {
        target *= 0.45;
        n.halo.material.color.setHex(CLR_DEFICIT);
        n.coreGlow.material.color.setHex(CLR_DEFICIT);
        n.halo.material.opacity = 0.35;
        n.coreGlow.material.opacity = 0.5;
      } else {
        n._atrophyUntil = 0;
        _refreshNodes();   // restore true color/state now that the flicker's over
      }
    }

    const cur = n.halo.scale.x + (target - n.halo.scale.x) * Math.min(1, dt * 8);
    n.halo.scale.setScalar(cur);
    n.coreGlow.scale.setScalar(cur * 0.42);
    n.core.scale.setScalar(n._pulse ? 1 + 0.12 * Math.sin(t * 4 + n.idx) : 1);
  }

  if (_cinematic) {
    _advanceCinematic(dt);
  } else if (_dragging) {
    // rotation is driven directly by pointermove while dragging; _spinVelY just
    // tracks the latest delta so release can pick up the momentum below.
  } else if (Math.abs(_spinVelY) > 0.0003) {
    // Momentum flick: let the drag's last angular velocity carry the spin, decaying via friction,
    // before settling back into the constant idle auto-rotate — reads as a deliberate glide, not a snap.
    _brainGroup.rotation.y += _spinVelY;
    _spinVelY *= Math.pow(0.05, dt);   // frame-rate-independent exponential friction
  } else if (_idleSpin) {
    _brainGroup.rotation.y += 0.0016;
  }

  // Wheel-zoom eases toward its target distance instead of jump-cutting per tick.
  if (_camDistTarget != null) {
    const cur = _camera.position.length();
    if (Math.abs(_camDistTarget - cur) > 0.001) {
      _camera.position.setLength(cur + (_camDistTarget - cur) * Math.min(1, dt * 10));
    }
  }

  _renderer.render(_scene, _camera);
}

function _advanceCinematic(dt) {
  const C = _cinematic; C.elapsed += dt;
  const IN = 1.6, HOLD = 3.0, OUT = 2.2;
  if (C.phase === 'in') {
    const k = _smoothstep(C.elapsed / IN);
    _applyOrientation(C.from[0] + (C.to[0]-C.from[0])*k, C.from[1] + (C.to[1]-C.from[1])*k);
    if (C.elapsed >= IN) { C.phase = 'hold'; C.elapsed = 0; C.onStep?.(C.i); }
  } else if (C.phase === 'hold') {
    if (C.elapsed >= HOLD) {
      C.i++;
      if (C.i >= C.steps.length) { C.phase = 'out'; C.elapsed = 0; C.from = _curOrient(); C.to = TOUR_DEFAULT.slice(); }
      else { C.phase = 'in'; C.elapsed = 0; C.from = _curOrient(); C.to = C.steps[C.i].angle; }
    }
  } else if (C.phase === 'out') {
    const k = _smoothstep(C.elapsed / OUT);
    _applyOrientation(C.from[0] + (C.to[0]-C.from[0])*k, C.from[1] + (C.to[1]-C.from[1])*k);
    if (C.elapsed >= OUT) { const done = C; _cinematic = null; _idleSpin = true; done.onComplete?.(); }
  }
}
function _curOrient() {
  return [THREE.MathUtils.radToDeg(_brainGroup.rotation.y) + 180, THREE.MathUtils.radToDeg(_brainGroup.rotation.x)];
}

// ═══════════════════════════════════════════════════════════════════════════════
// POINTER INTERACTION  (drag-rotate · wheel-zoom, up = zoom in)
// ═══════════════════════════════════════════════════════════════════════════════
// Raycast a screen point against nodes (then tracts) and announce the connected
// tract via a `tractClicked` event, which game.js turns into a HUD-card highlight
// + clinical-insight update. Mode-independent: nodes/tracts exist in both views.
function _dispatchTract(key) {
  if (key) window.dispatchEvent(new CustomEvent('tractClicked', { detail: { tractKey: key } }));
}
function _tractForNode(idx) {
  let fallback = null;
  for (const t of _tracts) {
    if (!(t.tract.aalRegions || []).includes(idx)) continue;
    const st = _tractStatus(t);
    if (st === 'deficit' || st === 'hyper') return t;   // prefer the clinically salient one
    if (!fallback) fallback = t;
  }
  return fallback;
}
function _pickAt(clientX, clientY) {
  if (!_ready || !_raycaster) return;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  _brainGroup.updateMatrixWorld(true);
  _raycaster.setFromCamera(ndc, _camera);
  // Node cores + halos first (halos are large, easy targets)…
  const nodeHits = _raycaster.intersectObjects(_nodes.flatMap(n => [n.core, n.halo]), false);
  if (nodeHits.length) {
    const node = nodeHits[0].object.userData.node;
    if (node) { const t = _tractForNode(node.idx); if (t) _dispatchTract(t.key); }
    return;
  }
  // …then the tract tubes themselves.
  const tubeHits = _raycaster.intersectObjects(_tracts.map(t => t.tube), false);
  if (tubeHits.length) {
    const t = _tracts.find(t => t.tube === tubeHits[0].object);
    if (t) _dispatchTract(t.key);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §3 SURGICAL PLANNING — click the glass brain to drop a lesion sphere; report
// which white-matter tracts it intersects and the predicted deficit.
// ═══════════════════════════════════════════════════════════════════════════════
const LESION_DEFICIT = {
  arcuate:       'Language deficit — conduction aphasia (impaired repetition)',
  fat:           'Speech-initiation / verbal-fluency deficit',
  cingulum:      'Executive dysfunction & attentional / conflict-monitoring deficit',
  slf2:          'Working-memory & spatial-attention deficit (possible neglect)',
  fornix:        'Anterograde episodic-memory deficit',
  uf:            'Social-emotional dysregulation / disinhibition',
  cst:           'Contralateral motor weakness (corticospinal)',
  frontalLocal:  'Frontal-executive dysfunction',
  stoppingRight: 'Loss of response inhibition / impulsivity',
  setShifting:   'Cognitive-inflexibility / perseveration',
};

function _pickShellPoint(clientX, clientY) {
  if (!_ready || !_raycaster || !_shellMesh) return null;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  _brainGroup.updateMatrixWorld(true);
  _raycaster.setFromCamera(ndc, _camera);
  const hits = _raycaster.intersectObject(_shellMesh, false);
  return hits.length ? hits[0].point.clone() : null;
}

function _lesionCollisions(lesion) {
  const N = 26, hits = [];
  for (const t of _tracts) {
    if (!t.curve) continue;
    let minD = Infinity;
    for (let i = 0; i <= N; i++) {
      const d = t.curve.getPoint(i / N).distanceTo(lesion.center);
      if (d < minD) minD = d;
    }
    if (minD < lesion.radius) {
      hits.push({ key: t.key, name: t.tract.name, deficit: LESION_DEFICIT[t.key] || 'Functional deficit', dist: minD });
    }
  }
  return hits.sort((a, b) => a.dist - b.dist);
}

function _dropLesion(clientX, clientY) {
  const worldPt = _pickShellPoint(clientX, clientY);
  if (!worldPt) return;
  const surf = _brainGroup.worldToLocal(worldPt.clone());     // cortical hit point (group-local)
  // Seat the lesion ~45% inward from the cortex toward the brain centroid, so it
  // sits in the sub-cortical white matter where the tracts actually run.
  const center = surf.clone().add(_meshCenter.clone().sub(surf).multiplyScalar(0.45));
  const radius = _meshHalf.length() * 0.19;                   // ~ tumour / impact zone
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 20, 16),
    new THREE.MeshBasicMaterial({ color: 0xff3b60, transparent: true, opacity: 0.26, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  mesh.position.copy(center);
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.28, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xff5a7a }),
  );
  core.position.copy(center);
  _brainGroup.add(mesh); _brainGroup.add(core);
  const lesion = { mesh, core, center, radius };
  _lesions.push(lesion);
  const warnings = _lesionCollisions(lesion);
  window.dispatchEvent(new CustomEvent('lesionDropped', { detail: {
    warnings, index: _lesions.length, center: [center.x, center.y, center.z],
  } }));
}

function _clearLesions() {
  for (const l of _lesions) {
    _brainGroup.remove(l.mesh); l.mesh.geometry.dispose(); l.mesh.material.dispose();
    _brainGroup.remove(l.core); l.core.geometry.dispose(); l.core.material.dispose();
  }
  _lesions = [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// §2 ON-DEMAND NiiVue IMPORTER — real CT/MRI (.nii/.nii.gz/DICOM).
// STRICT single-context discipline for integrated GPUs: NiiVue and Three.js NEVER
// render at the same time. Opening NiiVue fully pauses + hides the Three.js scene;
// closing it destroys the NiiVue GL context before Three.js resumes.
// ═══════════════════════════════════════════════════════════════════════════════
const _NV_STATUS = () => document.getElementById('niivue-status');

async function _openNiiVue() {
  if (_nvReal) return;
  // 1) PAUSE + HIDE Three.js (frees the GPU for NiiVue).
  _paused = true;
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  canvas.style.display = 'none';
  document.getElementById('niivue-overlay')?.classList.add('open');
  _nvCanvas = document.getElementById('niivue-real');
  if (_nvCanvas) _nvCanvas.style.display = 'block';
  if (_NV_STATUS()) _NV_STATUS().textContent = 'Starting NiiVue engine…';

  // 2) ONLY NOW spin up NiiVue (lazy-loaded so it never costs memory otherwise).
  try {
    const CDNS = ['https://esm.sh/@niivue/niivue@0.44.2', 'https://cdn.jsdelivr.net/npm/@niivue/niivue@0.44.2/+esm'];
    let Niivue = null;
    for (const url of CDNS) {
      try { const m = await import(url); Niivue = m.Niivue ?? m.default?.Niivue ?? m.default; if (Niivue) break; } catch (_) {}
    }
    if (!Niivue) { if (_NV_STATUS()) _NV_STATUS().textContent = 'Could not load the NiiVue engine (check network).'; return; }
    _nvReal = new Niivue({ backColor: [0.02, 0.03, 0.06, 1], dragAndDropEnabled: true, isColorbar: true, isRadiologicalConvention: false });
    await _nvReal.attachToCanvas(_nvCanvas);
    if (_NV_STATUS()) _NV_STATUS().textContent = 'Drag a .nii / .nii.gz (or DICOM folder) onto the panel, or use “Choose file”.';
  } catch (e) {
    console.error('[NiiVue importer] init failed', e);
    if (_NV_STATUS()) _NV_STATUS().textContent = 'NiiVue failed to initialise.';
  }
}

async function _loadNiiVueFile(file) {
  if (!_nvReal || !file) return;
  try {
    if (_NV_STATUS()) _NV_STATUS().textContent = `Loading ${file.name}…`;
    const url = URL.createObjectURL(file);
    await _nvReal.loadVolumes([{ url, name: file.name }]);   // `name` carries the extension for format detection
    if (_NV_STATUS()) _NV_STATUS().textContent = `Loaded: ${file.name}`;
  } catch (e) {
    console.error('[NiiVue importer] load failed', e);
    if (_NV_STATUS()) _NV_STATUS().textContent = 'Could not read this file (unsupported or corrupt).';
  }
}

function _closeNiiVue() {
  // 3) DESTROY the NiiVue GL context to reclaim GPU memory BEFORE resuming Three.js.
  try {
    const gl = _nvReal && _nvReal.gl;
    const ext = gl && gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  } catch (_) {}
  _nvReal = null;
  if (_nvCanvas) _nvCanvas.style.display = 'none';
  document.getElementById('niivue-overlay')?.classList.remove('open');
  // 4) UNPAUSE + SHOW Three.js.
  canvas.style.display = 'block';
  _paused = false;
  if (!_rafId) { _lastT = performance.now(); _rafId = requestAnimationFrame(_loop); }
}

function _installInteraction() {
  let px = 0, py = 0, downX = 0, downY = 0, lastMoveT = 0;
  canvas.addEventListener('pointerdown', e => {
    _dragging = true; px = e.clientX; py = e.clientY; downX = e.clientX; downY = e.clientY;
    _spinVelY = 0; lastMoveT = performance.now();
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup',   e => {
    _dragging = false; try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    // Held still before releasing (no recent pointermove) → no momentum flick on release.
    if (performance.now() - lastMoveT > 120) _spinVelY = 0;
    // A near-stationary press = a click → raycast-pick a node/tract (both view modes).
    if (Math.hypot(e.clientX - downX, e.clientY - downY) < 6) {
      if (_surgicalMode) _dropLesion(e.clientX, e.clientY);   // §3 drop a lesion sphere
      else               _pickAt(e.clientX, e.clientY);       // otherwise pick a node/tract
    }
  });
  canvas.addEventListener('pointermove', e => {
    if (!_dragging || _cinematic) return;
    const dxRot = (e.clientX - px) * 0.008;
    _brainGroup.rotation.y += dxRot;
    _brainGroup.rotation.x += (e.clientY - py) * 0.008;
    _brainGroup.rotation.x = Math.max(-1.3, Math.min(1.3, _brainGroup.rotation.x));
    _spinVelY = dxRot;   // remember latest delta so release can decay into it (momentum flick)
    lastMoveT = performance.now();
    px = e.clientX; py = e.clientY;
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 0.9 : 1.1;   // scroll up → camera closer → zoom in
    const min = _meshHalf.length() * 1.1, max = _meshHalf.length() * 6;
    const base = _camDistTarget ?? _camera.position.length();
    _camDistTarget = Math.max(min, Math.min(max, base * factor));
  }, { passive: false });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════
(async function init() {
  setLoadingText('Loading 3D engine…');
  _dbg('init: starting (Three.js hologram engine)');
  try {
    const CDNS = [
      'https://esm.sh/three@0.160.0',
      'https://cdn.jsdelivr.net/npm/three@0.160.0/+esm',
      'https://unpkg.com/three@0.160.0/build/three.module.js',
    ];
    for (const url of CDNS) {
      _dbg(`trying three CDN: ${url.split('/')[2]}…`);
      try {
        const mod = await Promise.race([
          import(url),
          new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 18000)),
        ]);
        THREE = mod;
        if (THREE?.WebGLRenderer) { _dbg(`three loaded OK from ${url.split('/')[2]}`); break; }
        THREE = null;
      } catch (e) { _dbg(`CDN FAIL: ${String(e.message).slice(0, 60)}`); }
    }
    if (!THREE?.WebGLRenderer) { setLoadingText('3D engine unavailable — check your connection and reload.'); return; }

    // Renderer — tuned for integrated graphics.
    _renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: true, // snapshot-safe
    });
    _renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    const cont = canvas.parentElement;
    const W = (cont ? cont.offsetWidth : 0) || window.innerWidth;
    const H = (cont ? cont.offsetHeight : 0) || window.innerHeight;
    _renderer.setSize(W, H, false);
    _dbg(`renderer ${W}×${H} dpr=${_renderer.getPixelRatio()}`);

    _scene = new THREE.Scene();
    _scene.background = new THREE.Color(0x060a12);
    _scene.fog = new THREE.FogExp2(0x060a12, 0.0016);

    _camera = new THREE.PerspectiveCamera(45, W / H, 1, 4000);
    _brainGroup = new THREE.Group();
    _scene.add(_brainGroup);

    // Fetch labels (for lobe classification) + the cortex mesh in parallel.
    setLoadingText('Loading cortex mesh…');
    let objText;
    try {
      const [lab, obj] = await Promise.all([
        fetch('./aal.json').then(r => r.json()).catch(() => ({ labels: [] })),
        fetch(BRAIN_MESH_URL).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }),
      ]);
      _aalLabels = lab.labels ?? [];
      objText = obj;
    } catch (e) {
      _dbg('asset load FAIL: ' + e.message);
      setLoadingText('Could not load the cortex mesh (serve the app over http://).');
      return;
    }

    const geo = _parseOBJ(objText);
    const bb = geo.boundingBox;
    _meshCenter = bb.getCenter(new THREE.Vector3());
    _meshHalf = bb.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    _computeMniBounds();   // normalise the node cloud to its own extent → fills the shell
    _dbg(`mesh parsed: ${geo.attributes.position.count} verts, half=${_meshHalf.toArray().map(v=>v.toFixed(0)).join(',')}`);

    _shellMat = _makeShellMaterial();
    _shellMat.uniforms.uDefRadius.value = _meshHalf.length() * 0.32;  // deficit erosion reach
    // Per-vertex atrophy density attribute (default 1 = dense/healthy); the
    // anatomical shader reads it, and _loadAtrophy() overwrites it if a file exists.
    geo.setAttribute('aAtrophy', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count).fill(1.0), 1));
    _shellGeo = geo;
    _shellMatAnat = _makeAnatomicalMaterial();
    const shell = new THREE.Mesh(geo, _shellMat);
    shell.renderOrder = 10;       // draw last so interior nodes/tracts show through
    _shellMesh = shell;
    _brainGroup.add(shell);
    _loadAtrophy();               // async; no-ops cleanly if ./atrophy.json is absent

    _buildGridRing();
    _buildTracts();
    _buildNetworkEdges();
    _buildNodes();
    _refreshAll();

    // Frame the camera to fit the mesh.
    const dist = _meshHalf.length() / Math.tan(THREE.MathUtils.degToRad(_camera.fov / 2)) * 1.5;
    _camera.position.set(0, _meshHalf.y * 0.15, dist);
    _camDistTarget = _camera.position.length();
    _camera.lookAt(_meshCenter);
    _applyOrientation(TOUR_DEFAULT[0], TOUR_DEFAULT[1]);

    _raycaster = new THREE.Raycaster();
    if (_raycaster.params.Sprite) _raycaster.params.Sprite.threshold = 0;   // precise sprite picking
    _installInteraction();
    canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault(); _ready = false;
      if (_rafId) cancelAnimationFrame(_rafId);
      _dbg('WebGL context LOST'); _showGPUCrashCard();
    }, false);

    _lastT = performance.now();
    _rafId = requestAnimationFrame(_loop);
    _ready = true;
    setLoadingText(null);
    _dbg('READY ✓  (nodes=' + _nodes.length + ' tracts=' + _tracts.length + ')');
  } catch (err) {
    _dbg('FATAL: ' + err.message);
    setLoadingText('3D engine failed to initialise.');
  }
})();

window.addEventListener('beforeunload', () => {
  _safe(() => { const ext = _renderer?.getContext()?.getExtension('WEBGL_lose_context'); ext?.loseContext(); });
});
let _resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (!_renderer) return;
    const cont = canvas.parentElement;
    const W = (cont ? cont.offsetWidth : 0) || window.innerWidth;
    const H = (cont ? cont.offsetHeight : 0) || window.innerHeight;
    _camera.aspect = W / H; _camera.updateProjectionMatrix();
    _renderer.setSize(W, H, false);
  }, 150);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API  (window.brain) — preserved 1:1 from the NiiVue build
// ═══════════════════════════════════════════════════════════════════════════════
window.brain = {

  drawDigitalTwin(values) {
    this.clearDigitalTwin();
    const analyses = [];
    const deficit = new Set(), hyper = new Set();
    const addRegions = (set, tract) => {
      if (tract.aalRegions) tract.aalRegions.forEach(i => set.add(i));
      else [tract.from, tract.to].forEach(rk => (REGION_TO_AAL[rk] ?? []).forEach(i => set.add(i)));
    };
    Object.entries(CONNECTOME_DATABASE).forEach(([testKey, testDef]) => {
      const value = values[testKey] ?? null;
      const c = classify(testKey, value);
      const norm = NORMATIVE[testKey] ?? {};
      testDef.tracts.forEach(tract => {
        const status = value == null ? 'untested' : (tract.getStatus ? tract.getStatus(value) : 'reference');
        if (status === 'deficit') addRegions(deficit, tract);
        else if (status === 'hyper') addRegions(hyper, tract);
        const untested = status === 'untested';
        analyses.push({
          testName: testDef.testName, tractName: tract.name, tractKey: tract.key,
          profile: testDef.profile ?? null, value, status,
          z: untested ? null : c.z,
          metric: untested ? null : (norm.metric ?? null),
          unit: untested ? null : (norm.unit ?? null),
          note: untested
            ? 'This assessment has not been completed — no data is available to model this pathway. Run the test to populate it.'
            : (tract.getNote ? tract.getNote(value ?? 0, status) : ''),
          insight: tract.insight ?? null,
          citations: untested ? [] : (tract.citations ?? []),
        });
      });
    });
    _twinScores = values; _baselineMode = false;
    _deficitIdx = deficit; _hyperIdx = hyper; _highlightIdx = new Set();
    _refreshAll();
    return analyses;
  },

  clearDigitalTwin() {
    _deficitIdx = new Set(); _hyperIdx = new Set(); _twinScores = null; _baselineMode = false;
    _refreshAll();
  },

  setBaselineMode(isBaseline) { _baselineMode = !!isBaseline; _refreshAll(); },

  setCortexCutaway(enabled) {
    // Bulletproof "peel": drop the glass shell to a whisper so the interior
    // tracts/nodes read clearly (true GPU clip-plane cross-section is a future
    // enhancement; this keeps the Iris Xe path simple and reliable).
    if (_shellMat) _shellMat.uniforms.uOpacity.value = enabled ? 0.10 : 0.55;
  },

  playTwinCinematic(analysisResults, onStep, onComplete) {
    this.stopTwinCinematic();
    const steps = (analysisResults ?? []).map(a => ({
      tractKey: a.tractKey, angle: (TOUR_ANGLES[a.tractKey] ?? TOUR_DEFAULT).slice(),
    }));
    if (!steps.length || !_ready) { onComplete?.(); return; }
    _idleSpin = false;
    _cinematic = { steps, i: 0, phase: 'in', elapsed: 0, from: _curOrient(), to: steps[0].angle, onStep, onComplete };
  },
  stopTwinCinematic() {
    if (!_cinematic) return;
    const C = _cinematic; _cinematic = null; _idleSpin = true;
    _applyOrientation(TOUR_DEFAULT[0], TOUR_DEFAULT[1]);
    C.onComplete?.();
  },
  isCinematicPlaying() { return _cinematic !== null; },

  exportBrainSnapshot() {
    if (!_ready) return '';
    _safe(() => _renderer.render(_scene, _camera));
    try { return _renderer.domElement.toDataURL('image/png'); }
    catch (e) { console.warn('[Brain Trainer] snapshot failed:', e); return ''; }
  },

  /**
   * Capture the patient brain and the healthy-baseline brain from the SAME camera
   * angle, for a side-by-side comparison. Reuses the single renderer (no second
   * WebGL context — safe on integrated GPUs). Returns two PNG data URLs.
   */
  captureComparison() {
    if (!_ready) return null;
    const grab = () => { _safe(() => _renderer.render(_scene, _camera)); try { return _renderer.domElement.toDataURL('image/png'); } catch (_) { return ''; } };
    const prev = _baselineMode;
    _baselineMode = false; _refreshAll(); const patient  = grab();   // deficits + atrophy shown
    _baselineMode = true;  _refreshAll(); const baseline = grab();   // healthy reference
    _baselineMode = prev;  _refreshAll(); _safe(() => _renderer.render(_scene, _camera));
    return { patient, baseline };
  },

  setSceneBackground(hexColor) {
    if (!_ready) return;
    const h = typeof hexColor === 'number' ? hexColor : 0x060a12;
    _scene.background.setHex(h);
    if (_scene.fog) _scene.fog.color.setHex(h);
  },
  setSceneLightingFactor(_f) { /* no-op (unlit hologram) */ },
  restoreSceneLighting() { /* no-op */ },

  setBaselineGhostVisible(_v) {
    // Tour X-ray: fade the shell + dim resting nodes, leaving deficit/hyper lit.
    _tourMode = !_v;
    if (_shellMat) _shellMat.uniforms.uOpacity.value = _v ? 0.55 : 0.14;
    _refreshAll();
  },
  setGridVisible(v) { if (_gridRing) _gridRing.visible = !!v; },

  // ── Dual-mode view: 'hologram' (functional connectivity) | 'anatomical' (scan) ──
  setViewMode(mode) { _setViewMode(mode); return _viewMode; },
  getViewMode() { return _viewMode; },
  hasAtrophyData() { return _atrophyLoaded; },

  // ── §3 Surgical Planning (lesion network mapping) ──────────────────────────
  setSurgicalMode(on) { _surgicalMode = !!on; return _surgicalMode; },
  getSurgicalMode() { return _surgicalMode; },
  clearLesions() { _clearLesions(); },
  lesionCount() { return _lesions.length; },

  // ── §4D Longitudinal progression (0 = today … 1 = +5 yr) ───────────────────
  // _progress eases toward _progressTarget once per frame in _loop() rather than
  // snapping instantly, so dragging (or clicking) the timeline slider reads as a
  // smooth aging transition instead of an abrupt jump-cut.
  setProgression(frac) {
    _progressTarget = Math.max(0, Math.min(1, Number(frac) || 0));
    return _progressTarget;
  },
  getProgression() { return _progressTarget; },
  /** Project a Z-score forward in time (deficits deepen with progression). */
  projectZ(z, frac) {
    const p = Math.max(0, Math.min(1, Number(frac ?? _progress) || 0));
    if (z == null) return z;
    return z < 0 ? z * (1 + p * 1.4) : z * (1 - p * 0.15);   // deficits worsen, strengths drift toward mean
  },

  // ── §2 On-demand NiiVue importer (single-context safe) ─────────────────────
  openNiiVue() { return _openNiiVue(); },
  closeNiiVue() { _closeNiiVue(); },
  loadNiiVueFile(file) { return _loadNiiVueFile(file); },
  isNiiVueOpen() { return !!_nvReal || _paused; },

  activateRegion(regionKey) { _highlightIdx = new Set(COGNITIVE_REGION_AAL[regionKey] ?? []); _refreshAll(); },
  setRegionBrightness(regionKey, value) {
    _highlightIdx = value > 1 ? new Set(COGNITIVE_REGION_AAL[regionKey] ?? []) : new Set();
    _refreshAll();
  },
  deactivateRegions() { _highlightIdx = new Set(); _refreshAll(); },

  // ── Live in-task feedback (cosmetic; decays on its own each frame) ─────────
  // Call repeatedly during gameplay (e.g. once per tap) to make a region's
  // nodes visibly "warm up" in real time — each call adds a pop that fades
  // out over a fraction of a second, so a fast run of calls reads as building
  // intensity and it settles back down once they stop.
  pulseRegion(regionKey, amount = 0.35) {
    const idxs = COGNITIVE_REGION_AAL[regionKey] ?? [];
    for (const n of _nodes) {
      if (idxs.includes(n.idx)) n._energy = Math.min(1.6, (n._energy || 0) + amount);
    }
  },
  // Briefly flickers a region's nodes toward the "deficit" red/dim look, then
  // restores their true state. Purely a momentary visual beat (e.g. right
  // after a wrong answer) — never touches actual clinical deficit data.
  flashAtrophy(regionKey, durationMs = 800) {
    const idxs = COGNITIVE_REGION_AAL[regionKey] ?? [];
    const until = performance.now() + durationMs;
    for (const n of _nodes) {
      if (idxs.includes(n.idx)) n._atrophyUntil = until;
    }
  },

  // Retained no-ops for API compatibility.
  highlight() {}, clearHighlight() {}, setColor() {}, resetColors() {},
  drawConnection() {}, clearConnections() {},
  triggerNeuroplasticity() { playHeartbeat(); },

  getRegions: () => ({}),
  getSections: () => Object.keys(REGION_TO_AAL),
  get nv() { return null; },                       // legacy accessor (unused by game.js)
  get three() { return { renderer: _renderer, scene: _scene, camera: _camera }; },

  /**
   * Collapse raw clinical values into a per-domain cognitive footprint for the
   * radar chart (§3). Each domain's score is the mean sign-corrected Z (zc, where
   * negative = impaired) across its tested members.
   * @returns {Array<{label,zc:number|null,hasData:boolean,status}>}
   */
  computeDomainProfile(values) {
    values = values || {};
    return DOMAINS.map(d => {
      const zs = d.tests
        .map(k => classify(k, values[k]).zc)
        .filter(z => z != null && !Number.isNaN(z));
      const zc = zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : null;
      const status = zc == null ? 'untested' : zc <= -1.5 ? 'deficit' : zc >= 1.5 ? 'hyper' : 'normal';
      return { label: d.label, zc, hasData: zs.length > 0, status };
    });
  },
};
