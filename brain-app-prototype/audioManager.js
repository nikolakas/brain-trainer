// audioManager.js
// Web Audio API synthesizer — all sounds are generated mathematically.
// No external audio files are required.
//
// AudioContext is created lazily on the first call so the browser's autoplay
// policy (which requires a prior user gesture) is always satisfied.  Both
// app.js and game.js import from this module; ES modules are singletons, so
// the same AudioContext and master gain node are shared across both files.

let _ctx    = null;
let _master = null;

function _boot() {
  if (!_ctx) {
    _ctx    = new (window.AudioContext || window.webkitAudioContext)();
    _master = _ctx.createGain();
    _master.gain.value = 0.15;   // master fader — subtle, non-intrusive
    _master.connect(_ctx.destination);
  }
  // Resume if the browser suspended the context between user gestures
  if (_ctx.state === 'suspended') _ctx.resume();
  return { ctx: _ctx, master: _master };
}

// ─── Sound 1: UI Click ────────────────────────────────────────────────────────
// Triangle oscillator at 820 Hz with a 4 ms linear attack and a 120 ms
// exponential decay.  The pitch glides down to 420 Hz during the decay to
// give the tap a slight 'tock' character that cuts through without being harsh.
// Used for: raycasted tract selection and major action buttons.
export function playClick() {
  const { ctx, master } = _boot();
  const t = ctx.currentTime;

  const osc  = ctx.createOscillator();
  osc.type   = 'triangle';
  osc.frequency.setValueAtTime(820, t);
  osc.frequency.exponentialRampToValueAtTime(420, t + 0.10);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(1.0,   t + 0.004);   // 4 ms attack
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12); // 116 ms decay

  osc.connect(gain);
  gain.connect(master);
  osc.start(t);
  osc.stop(t + 0.14);
}

// ─── Sound 2: Heartbeat ───────────────────────────────────────────────────────
// Sine oscillator at sub-bass (55–70 Hz) with a classic lub-dub amplitude
// envelope: a short, sharp first beat followed by a softer, slightly longer
// second beat, completing in ~400 ms.  Pitch also glides slightly on each beat
// to add organ-like body mass to the thud.
// Used for: triggerNeuroplasticity() — reinforces the feeling of biological change.
export function playHeartbeat() {
  const { ctx, master } = _boot();
  const t = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type  = 'sine';

  // Pitch envelope — slight drop on each beat for a fleshy 'thud' quality
  osc.frequency.setValueAtTime(70, t);
  osc.frequency.exponentialRampToValueAtTime(45, t + 0.10);
  osc.frequency.setValueAtTime(65, t + 0.18);
  osc.frequency.exponentialRampToValueAtTime(45, t + 0.30);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);

  // Lub — short, sharp first beat
  gain.gain.linearRampToValueAtTime(1.0,   t + 0.022);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);

  // Dub — slightly softer, slightly longer second beat
  gain.gain.linearRampToValueAtTime(0.65,  t + 0.19);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.36);

  osc.connect(gain);
  gain.connect(master);
  osc.start(t);
  osc.stop(t + 0.40);
}

// ─── Sound 3: Cinematic Whoosh ────────────────────────────────────────────────
// White-noise buffer (Math.random, no signal library) piped through a lowpass
// BiquadFilter whose cutoff exponentially sweeps from 2 400 Hz to 160 Hz over
// 1.8 s.  The falling filter creates the sensation of rushing air decelerating
// — a high-tech "arrival" cue that pairs with the cinematic camera lerp.
// Used for: each camera step arrival in playTwinCinematic().
export function playWhoosh() {
  const { ctx, master } = _boot();
  const t = ctx.currentTime;

  // Allocate a single 1.8-second noise buffer per call; freed by GC after stop
  const frames = Math.ceil(ctx.sampleRate * 1.8);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data   = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

  const noise  = ctx.createBufferSource();
  noise.buffer = buffer;

  // Lowpass — cutoff sweeps downward to produce the "flying past" illusion
  const filter   = ctx.createBiquadFilter();
  filter.type    = 'lowpass';
  filter.Q.value = 1.4;
  filter.frequency.setValueAtTime(2400, t);
  filter.frequency.exponentialRampToValueAtTime(160, t + 1.8);

  // Amplitude: fast attack → brief sustain plateau → long exponential tail
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(1.0,   t + 0.14);
  gain.gain.setValueAtTime(1.0,            t + 0.30);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.75);

  noise.connect(filter);
  filter.connect(gain);
  gain.connect(master);
  noise.start(t);
  noise.stop(t + 1.8);
}
