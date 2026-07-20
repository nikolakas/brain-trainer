// ─── Brain Trainer — Research-Grade Clinical Battery ─────────────────────────
// Block-design cognitive tests + AQ-10, scored against a normative Z-score engine.
import { playClick, playWhoosh } from './audioManager.js?v=20260704b';
import { NORMATIVE, classify } from './connectome_database.js?v=20260704b';

// ── Probit function (for d-prime) ────────────────────────────────────────────
// Abramowitz & Stegun 26.2.17 rational approximation, max error ≈ 4.5×10⁻⁴.
function _normInv(p) {
  p = Math.max(1e-9, Math.min(1 - 1e-9, p));
  const sign = p >= 0.5 ? 1 : -1;
  const t = Math.sqrt(-2 * Math.log(p < 0.5 ? p : 1 - p));
  const c = [2.515517, 0.802853, 0.010328];
  const d = [1.432788, 0.189269, 0.001308];
  return sign * (t - (c[0] + t*(c[1] + t*c[2])) / (1 + t*(d[0] + t*(d[1] + t*d[2]))));
}

// ── Practice round infrastructure ─────────────────────────────────────────────
// Each supported test runs one unscored practice round on its first launch per session.
const _practiceDone = { rsvp: false, nback: false, stroop: false, corsi: false };
let _inPractice = false;

const RSVP_PRACTICE_PASSAGE = {
  words:    ['The', 'cat', 'jumped', 'over', 'the', 'fence.'],
  question: 'What did the cat jump over?',
  answers:  [
    { text: 'The fence',  correct: true  },
    { text: 'The wall',   correct: false },
    { text: 'The garden', correct: false },
  ],
};

function _showPracticeBadge(visible) {
  const el = document.getElementById('practice-badge');
  if (el) el.style.display = visible ? 'flex' : 'none';
}

function _showPracticeResult(isCorrect) {
  const key = currentTest;
  showScreen('result');
  const numEl = document.getElementById('score-num');
  numEl.textContent = isCorrect ? '✓' : '✗';
  numEl.className   = isCorrect ? 'reveal good' : 'reveal poor';
  document.getElementById('score-tag').textContent  = 'PRACTICE — not recorded';
  document.getElementById('score-tag').style.color  = '#2563EB';
  document.getElementById('result-msg').textContent = isCorrect
    ? 'Well done — you understood the task. The real test starts now.'
    : 'No problem — that was just practice. The real test starts now.';
  document.getElementById('brain-msg').textContent = '';
  document.getElementById('citation-block').classList.add('hidden');
  document.getElementById('validity-warning').classList.add('hidden');
  document.getElementById('btn-reset').disabled = true;
  setTimeout(() => _finishPractice(key), 2200);
}

function _finishPractice(key) {
  _inPractice = false;
  _practiceDone[key] = true;
  _showPracticeBadge(false);
  startTestByKey(key);   // now launches real test
}

// ── Constants ─────────────────────────────────────────────────────────────────
const RSVP_PASSAGES = [
  {
    words:   ['The', 'surgeon', 'bypassed', 'the', 'occluded', 'coronary', 'vessel.'],
    question: 'What was bypassed?',
    answers: [
      { text: 'The aortic valve',     correct: false },
      { text: 'The occluded vessel',  correct: true  },
      { text: 'The cerebral cortex',  correct: false },
    ],
  },
  {
    words:   ['Synaptic', 'plasticity', 'underpins', 'long-term', 'memory', 'consolidation.'],
    question: 'What does synaptic plasticity underpin?',
    answers: [
      { text: 'Short-term caching',  correct: false },
      { text: 'Long-term memory',    correct: true  },
      { text: 'Motor coordination',  correct: false },
    ],
  },
  {
    words:   ['Neural', 'oscillations', 'synchronize', 'across', 'distant', 'cortical', 'regions.'],
    question: 'What do neural oscillations synchronize?',
    answers: [
      { text: 'Subcortical nuclei',       correct: false },
      { text: 'Distant cortical regions', correct: true  },
      { text: 'Peripheral nerve fibers',  correct: false },
    ],
  },
  {
    words:   ['Dopaminergic', 'pathways', 'modulate', 'reward', 'prediction', 'and', 'motivation.'],
    question: 'What do dopaminergic pathways modulate?',
    answers: [
      { text: 'Sensory perception',    correct: false },
      { text: 'Reward and motivation', correct: true  },
      { text: 'Postural balance',      correct: false },
    ],
  },
  {
    words:   ['The', 'hippocampus', 'encodes', 'spatial', 'and', 'episodic', 'memory', 'traces.'],
    question: 'What does the hippocampus encode?',
    answers: [
      { text: 'Visual reflexes',             correct: false },
      { text: 'Spatial and episodic memory', correct: true  },
      { text: 'Motor skill programs',        correct: false },
    ],
  },
  {
    words:   ['Prefrontal', 'inhibition', 'suppresses', 'task-irrelevant', 'sensory', 'noise.'],
    question: 'What does prefrontal inhibition suppress?',
    answers: [
      { text: 'Working memory capacity',       correct: false },
      { text: 'Task-irrelevant sensory noise',  correct: true  },
      { text: 'Thalamo-cortical relay signals', correct: false },
    ],
  },
];
let rsvpPassage = RSVP_PASSAGES[0];  // replaced each game start

const RSVP_WORD_MS      = 300;
const RSVP_FAST_MS      = 2000;   // perfect-score threshold

const NBACK_N           = 2;      // 2-Back
const NBACK_LENGTH      = 30;     // continuous clinical stream (≥ 30 stimuli)
const NBACK_LETTER_MS   = 1200;   // letter on-screen
const NBACK_GAP_MS      = 300;    // blank inter-stimulus interval
const NBACK_PASS_PCT    = 80;     // corrected-detection % for "strong" response
const NBACK_ALPHABET    = 'BCDFGKLMNPRSTV'; // unambiguous consonants only

// ── Adaptive difficulty state ──────────────────────────────────────────────────
// Each test escalates as the patient copes, mimicking a staircased clinical
// assessment.  These are mutated live by the test loops.
let rsvpWordMs        = RSVP_WORD_MS;     // shrinks 22 ms per correct comprehension (floor 120)
let nbackLetterMs     = NBACK_LETTER_MS;  // adapts within a run from running accuracy
let stroopDeadlineMs  = 2200;             // per-trial response window, tightens with each correct
let stroopDeadlineTimeout = null;         // handle for the shrinking response-deadline timer

// ── Screen registry ───────────────────────────────────────────────────────────
const screens = {
  menu:     document.getElementById('screen-menu'),
  rsvp:     document.getElementById('screen-rsvp'),
  question: document.getElementById('screen-question'),
  nback:    document.getElementById('screen-nback'),
  stroop:   document.getElementById('screen-stroop'),
  corsi:    document.getElementById('screen-corsi'),
  fluency:  document.getElementById('screen-fluency'),
  aq10:     document.getElementById('screen-aq10'),
  ftt:      document.getElementById('screen-ftt'),
  gonogo:   document.getElementById('screen-gonogo'),
  trails:   document.getElementById('screen-trails'),
  rest:     document.getElementById('screen-rest'),
  result:   document.getElementById('screen-result'),
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

// ── Shared game state ─────────────────────────────────────────────────────────
let currentTest = null;          // 'rsvp' | 'nback' | 'stroop' | 'fingerTapping' | …

// Historical results — populated by showResult() for the future timeline UI.
// Each entry: { date: Date, test: string, score: number }
let userTimelineResults = [];

const LS_KEY         = 'neuroScreenerData';
const LS_PROFILE_KEY = 'neuroScreenerProfile';

// Patient demographic profile — loaded from localStorage at boot.
// { age, sex, educationYears, clarity, handedness, sleepDeprived, hasTBI, colorBlind, medications }
let userProfile = null;

// Returns a copy of the NORMATIVE entry for testKey adjusted for education & age.
// AQ-10 uses a fixed cut-off and is deliberately excluded from adjustment.
function getAdjustedNorm(testKey) {
  const base = NORMATIVE[testKey];
  if (!base || !userProfile || base.cutoff != null) return base;
  const n   = { ...base };
  const age = userProfile.age || 0;
  const edu = userProfile.educationYears || 0;

  // ── 5 age bands (Tombaugh et al. 1999; Kessels et al. 2000; van Boxtel et al. 2001) ──
  if (age >= 76) {
    if (testKey === 'stroop')        n.mean = Math.round(n.mean + 60);
    if (testKey === 'nback')         n.mean = parseFloat((n.mean - 0.55).toFixed(2));
    if (testKey === 'corsi')         n.mean = parseFloat(Math.max(3.0, n.mean - 0.8).toFixed(1));
    if (testKey === 'verbalFluency') n.mean = Math.round(Math.max(18, n.mean - 6));
    if (testKey === 'fingerTapping') n.mean = Math.round(Math.max(25, n.mean - 8));
    if (testKey === 'trailsB')       n.mean = Math.round(n.mean + 55);   // TMT-B slows sharply (Tombaugh 2004)
    if (testKey === 'goNoGo')        n.mean = Math.round(n.mean + 5);    // more commission errors with age
  } else if (age >= 61) {
    if (testKey === 'stroop')        n.mean = Math.round(n.mean + 35);
    if (testKey === 'nback')         n.mean = parseFloat((n.mean - 0.35).toFixed(2));
    if (testKey === 'corsi')         n.mean = parseFloat(Math.max(3.5, n.mean - 0.5).toFixed(1));
    if (testKey === 'verbalFluency') n.mean = Math.round(Math.max(22, n.mean - 4));
    if (testKey === 'fingerTapping') n.mean = Math.round(Math.max(30, n.mean - 5));
    if (testKey === 'trailsB')       n.mean = Math.round(n.mean + 32);
    if (testKey === 'goNoGo')        n.mean = Math.round(n.mean + 3);
  } else if (age >= 46) {
    if (testKey === 'stroop')        n.mean = Math.round(n.mean + 18);
    if (testKey === 'nback')         n.mean = parseFloat((n.mean - 0.15).toFixed(2));
    if (testKey === 'corsi')         n.mean = parseFloat(Math.max(4.0, n.mean - 0.2).toFixed(1));
    if (testKey === 'verbalFluency') n.mean = Math.round(Math.max(28, n.mean - 2));
    if (testKey === 'fingerTapping') n.mean = Math.round(Math.max(38, n.mean - 2));
    if (testKey === 'trailsB')       n.mean = Math.round(n.mean + 15);
  } else if (age >= 31) {
    if (testKey === 'stroop')        n.mean = Math.round(n.mean + 6);
    // 31–45: minimal adjustment — minor processing-speed drift only
  }
  // 18–30: peak performance band, no adjustment

  // ── 3 education levels (Tombaugh et al. 1999; Crawford et al. 1992) ──
  if (edu > 16) {
    // Postgraduate — raised lexical/executive reserve
    if (testKey === 'stroop')        n.mean = Math.round(n.mean * 0.88);
    if (testKey === 'verbalFluency') n.mean = Math.round(n.mean * 1.15);
    if (testKey === 'nback')         n.mean = parseFloat((n.mean + 0.20).toFixed(2));
    if (testKey === 'corsi')         n.mean = parseFloat((n.mean + 0.15).toFixed(1));
  } else if (edu <= 12) {
    // High-school or less — adjusted down for lexical-access and strategy tests
    if (testKey === 'verbalFluency') n.mean = Math.round(n.mean * 0.88);
    if (testKey === 'nback')         n.mean = parseFloat((n.mean - 0.15).toFixed(2));
    if (testKey === 'stroop')        n.mean = Math.round(n.mean * 1.10);
  }
  // 13–16 years: matches most published normative samples — no adjustment

  return n;
}

// Drop-in replacement for classify() that applies demographic norm adjustment.
function classifyAdjusted(testKey, value) {
  const n = getAdjustedNorm(testKey);
  if (!n || value == null) return { z: null, zc: null, status: 'normal' };
  if (n.cutoff != null) {
    const atypical = n.higherIsBetter ? value < n.cutoff : value >= n.cutoff;
    return { z: null, zc: null, status: atypical ? 'atypical' : 'normal' };
  }
  const z  = (value - n.mean) / n.sd;
  const zc = n.higherIsBetter ? z : -z;
  const status = zc <= -1.5 ? 'deficit' : zc >= 1.5 ? 'hyper' : 'normal';
  return { z, zc, status };
}

function saveResults() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(userTimelineResults)); } catch (_) {}
}

function loadResults() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return;
    // Re-hydrate Date strings back to Date objects
    userTimelineResults = parsed.map(r => ({ ...r, date: new Date(r.date) }));
    // Show the timeline immediately so the user sees prior history on boot
    renderDashboard();
    document.getElementById('dashboard-panel').classList.remove('hidden');
  } catch (_) {}
}

function clearHistory() {
  if (!confirm('Permanently delete all clinical history and reset the patient profile?\n\nThis will require re-entering patient demographics for a new session.')) return;
  userTimelineResults = [];
  userProfile = null;
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(LS_PROFILE_KEY);
  renderDashboard();
  document.getElementById('dashboard-panel').classList.add('hidden');
  showIntake();
}

// ── Patient Intake ────────────────────────────────────────────────────────────
function showIntake() {
  document.getElementById('intake-screen').classList.remove('hidden');
}

function submitIntake() {
  const age        = parseInt(document.getElementById('intake-age').value, 10);
  const edu        = parseInt(document.getElementById('intake-edu').value, 10);
  const sex        = document.querySelector('#intake-sex .seg-btn.active')?.dataset.val;
  const clarity    = parseInt(document.getElementById('intake-clarity').value, 10);
  const handedness    = document.getElementById('intake-handedness').value;
  const sleepDeprived = document.getElementById('intake-sleep').checked;
  const hasTBI        = document.getElementById('intake-tbi').checked;
  const colorBlind    = document.getElementById('intake-colorblind').checked;
  const medications   = document.getElementById('intake-meds').checked;

  const errEl = document.getElementById('intake-error');
  if (isNaN(age) || age < 16 || age > 99)    { errEl.textContent = 'Please enter a valid age (16–99).'; return; }
  if (isNaN(edu) || edu < 0  || edu > 30)    { errEl.textContent = 'Please enter years of education (0–30).'; return; }
  if (!sex)                                   { errEl.textContent = 'Please select a biological sex option.'; return; }
  if (!handedness)                            { errEl.textContent = 'Please select handedness.'; return; }
  errEl.textContent = '';

  userProfile = { age, sex, educationYears: edu, clarity, handedness, sleepDeprived, hasTBI, colorBlind, medications };
  try { localStorage.setItem(LS_PROFILE_KEY, JSON.stringify(userProfile)); } catch (_) {}

  document.getElementById('intake-screen').classList.add('hidden');
  loadResults();   // hydrate any historical data now that profile is set
}

// Segmented sex selector
document.querySelectorAll('#intake-sex .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#intake-sex .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// Clarity slider — live badge + CSS gradient fill
const _claritySlider = document.getElementById('intake-clarity');
const _clarityVal    = document.getElementById('clarity-val');
_claritySlider.addEventListener('input', () => {
  _clarityVal.textContent = _claritySlider.value;
  const pct = ((+_claritySlider.value - 1) / 9 * 100).toFixed(1) + '%';
  _claritySlider.style.setProperty('--val', pct);
});
_claritySlider.dispatchEvent(new Event('input'));   // init gradient on load

document.getElementById('btn-intake-submit').addEventListener('click', submitIntake);

// ── Profile Summary (dashboard + print) ──────────────────────────────────────
function renderProfileSummary() {
  const pEl  = document.getElementById('profile-summary');
  const cEl  = document.getElementById('confounder-alert');
  const ctEl = document.getElementById('confounder-text');
  if (!pEl || !cEl) return;

  if (!userProfile) { pEl.innerHTML = ''; cEl.classList.add('hidden'); return; }

  const sexLabel   = { M: 'Male', F: 'Female', O: 'Other / Not stated' }[userProfile.sex] || userProfile.sex;
  const handLabel  = { R: 'Right', L: 'Left', A: 'Ambidextrous' }[userProfile.handedness] || (userProfile.handedness || '—');
  const highEd     = userProfile.educationYears > 15;
  const confounders = [];
  if (userProfile.sleepDeprived) confounders.push('Acute sleep deprivation (<5 hrs)');
  if (userProfile.hasTBI)        confounders.push('History of TBI / concussion');
  if (userProfile.colorBlind)    confounders.push('Color vision deficit — Stroop Task invalidated');
  if (userProfile.medications)   confounders.push('Psychoactive medication use');

  pEl.innerHTML = `
    <div class="profile-summary-bar">
      <span class="psb-item"><span class="psb-label">Age</span>${userProfile.age}</span>
      <span class="psb-item"><span class="psb-label">Sex</span>${sexLabel}</span>
      <span class="psb-item"><span class="psb-label">Education</span>${userProfile.educationYears} yrs${highEd ? ' &middot; CR &uarr;' : ''}</span>
      <span class="psb-item"><span class="psb-label">Handedness</span>${handLabel}</span>
      <span class="psb-item"><span class="psb-label">Clarity</span>${userProfile.clarity}/10</span>
    </div>`;

  if (confounders.length > 0) {
    ctEl.textContent = confounders.join(' · ') + '. Interpret Z-scores with caution.';
    cEl.classList.remove('hidden');
  } else {
    cEl.classList.add('hidden');
  }
}

function populatePrintProfile() {
  const el = document.getElementById('print-patient-profile');
  if (!el) return;
  if (!userProfile) { el.innerHTML = ''; return; }

  const sexLabel  = { M: 'Male', F: 'Female', O: 'Other / Not stated' }[userProfile.sex] || userProfile.sex;
  const handLabel = { R: 'Right-handed', L: 'Left-handed', A: 'Ambidextrous' }[userProfile.handedness] || (userProfile.handedness || '—');
  const highEd    = userProfile.educationYears > 15;
  const senior    = userProfile.age >= 60;
  const confounders = [];
  if (userProfile.sleepDeprived) confounders.push('Acute sleep deprivation (<5 hrs)');
  if (userProfile.hasTBI)        confounders.push('History of TBI / concussion');
  if (userProfile.colorBlind)    confounders.push('Color vision deficit');
  if (userProfile.medications)   confounders.push('Psychoactive medication use');

  const normNote = [];
  if (highEd)  normNote.push('Cognitive Reserve adjustment (education >15 yrs)');
  if (senior)  normNote.push('Age-adjusted norms (age ≥60)');

  el.innerHTML = `
    <div class="pr-patient-profile">
      <span class="pr-pp-item"><span class="pr-pp-label">Age</span>${userProfile.age}</span>
      <span class="pr-pp-item"><span class="pr-pp-label">Sex</span>${sexLabel}</span>
      <span class="pr-pp-item"><span class="pr-pp-label">Handedness</span>${handLabel}</span>
      <span class="pr-pp-item"><span class="pr-pp-label">Education</span>${userProfile.educationYears} years</span>
      <span class="pr-pp-item"><span class="pr-pp-label">Clarity</span>${userProfile.clarity}/10</span>
      ${userProfile.medications ? `<span class="pr-pp-item"><span class="pr-pp-label">Medications</span>Psychoactive (active)</span>` : ''}
      ${normNote.length ? `<span class="pr-pp-item"><span class="pr-pp-label">Norm Adj.</span>${normNote.join('; ')}</span>` : ''}
    </div>
    ${userProfile.colorBlind ? `
    <div class="pr-confounder-print">
      <strong>[INVALIDATED]</strong> Stroop Task: color vision deficit renders the ink-color interference paradigm non-diagnostic.
      Exclude the Stroop Z-score from clinical interpretation for this patient.
    </div>` : ''}
    ${confounders.filter(c => c !== 'Color vision deficit').length ? `
    <div class="pr-confounder-print">
      <strong>[!] CLINICAL CONFOUNDER ALERT &mdash;</strong>
      ${confounders.join(' · ')}.
      Performance may be attenuated by non-pathological factors; interpret all Z-scores with caution.
    </div>` : ''}`;
}

// Boot — load profile, then results (or show intake if no profile exists)
{
  const _rawProfile = localStorage.getItem(LS_PROFILE_KEY);
  if (_rawProfile) { try { userProfile = JSON.parse(_rawProfile); } catch (_) {} }
}
if (userProfile) { loadResults(); } else { showIntake(); }

document.getElementById('btn-clear-history').addEventListener('click', clearHistory);

// ── RSVP state ────────────────────────────────────────────────────────────────
let rsvpTimerInterval = null;
let rsvpTimerStart    = null;

// ── N-Back state ──────────────────────────────────────────────────────────────
let nbackSequence     = [];
let nbackResults      = [];      // null for first N positions; object otherwise
let nbackCurrentIndex = -1;
let nbackHasPressed   = false;
let nbackAborted      = false;
let nbackLoopTimeout  = null;    // handle for the cancellable wait()

// Cancellable promise-based delay used in the async N-Back loop
function wait(ms) {
  return new Promise(resolve => { nbackLoopTimeout = setTimeout(resolve, ms); });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN MENU
// ═══════════════════════════════════════════════════════════════════════════════
// ── Test dispatcher (shared by the menu buttons and the Full Clinical Battery) ─
function startTestByKey(key) {
  currentTest = key;
  // First launch of each supported test: run a brief unscored practice round.
  if (!_inPractice && _practiceDone[key] === false) {
    _inPractice = true;
    _showPracticeBadge(true);
    switch (key) {
      case 'rsvp':
        rsvpPassage = RSVP_PRACTICE_PASSAGE;
        window.brain.activateRegion('readingGame');
        showScreen('rsvp'); runRSVP();
        return;
      case 'nback':
        window.brain.activateRegion('nBackGame');
        _startNBackPractice();
        return;
      case 'stroop':
        window.brain.activateRegion('stroopTask');
        _startStroopPractice();
        return;
      case 'corsi':
        window.brain.activateRegion('corsiGame');
        _startCorsiPractice();
        return;
      default:
        _practiceDone[key] = true; _inPractice = false; _showPracticeBadge(false);
    }
  }
  switch (key) {
    case 'rsvp':
      rsvpPassage = RSVP_PASSAGES[Math.floor(Math.random() * RSVP_PASSAGES.length)];
      window.brain.activateRegion('readingGame');
      showScreen('rsvp'); runRSVP();
      break;
    case 'nback':         window.brain.activateRegion('nBackGame');         startNBack();  break;
    case 'stroop':        window.brain.activateRegion('stroopTask');        startStroop(); break;
    case 'corsi':         window.brain.activateRegion('corsiGame');         startCorsi();  break;
    case 'verbalFluency': window.brain.activateRegion('fluencyGame');       startFluency();break;
    case 'aq10':          window.brain.activateRegion('aq10Game');          startAq10();   break;
    case 'fingerTapping': window.brain.activateRegion('fingerTappingGame'); startFTT();    break;
    case 'goNoGo':        window.brain.activateRegion('goNoGoGame');        startGoNoGo(); break;
    case 'trailsB':       window.brain.activateRegion('trailsGame');        startTrails(); break;
  }
}

const MENU_BTN = {
  'btn-start-rsvp': 'rsvp', 'btn-start-nback': 'nback', 'btn-start-stroop': 'stroop',
  'btn-start-corsi': 'corsi', 'btn-start-fluency': 'verbalFluency', 'btn-start-aq10': 'aq10',
  'btn-start-ftt': 'fingerTapping', 'btn-start-gonogo': 'goNoGo', 'btn-start-trails': 'trailsB',
};
Object.entries(MENU_BTN).forEach(([id, key]) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', () => { playClick(); startTestByKey(key); });
});

// Full Clinical Battery — every test in sequence with 10 s rest/baseline periods.
document.getElementById('btn-start-battery').addEventListener('click', () => { playClick(); startBattery(); });

// ── Menu hover diagnostics ─────────────────────────────────────────────────────
// Hovering a test card lights up that test's brain network in the live 3D render.
// Maps each test key to the cognitive-region key understood by window.brain.activateRegion.
const TEST_REGION = {
  rsvp: 'readingGame', nback: 'nBackGame', stroop: 'stroopTask',
  corsi: 'corsiGame', verbalFluency: 'fluencyGame', aq10: 'aq10Game',
  fingerTapping: 'fingerTappingGame', goNoGo: 'goNoGoGame', trailsB: 'trailsGame',
};
document.querySelectorAll('.test-row[data-test]').forEach(card => {
  const region = TEST_REGION[card.dataset.test];
  if (!region) return;
  card.addEventListener('mouseenter', () => {
    // Don't fight an in-progress test or the Digital Twin tour.
    if (currentTest || window.brain.isCinematicPlaying?.()) return;
    window.brain.activateRegion(region);
  });
  card.addEventListener('mouseleave', () => {
    if (currentTest) return;
    window.brain.deactivateRegions();
  });
});

// ── Quit buttons ─────────────────────────────────────────────────────────────
['btn-quit-rsvp', 'btn-quit-nback', 'btn-quit-stroop', 'btn-quit-corsi', 'btn-quit-fluency', 'btn-quit-aq10', 'btn-quit-ftt', 'btn-quit-gonogo', 'btn-quit-trails']
  .forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('click', resetToMenu); });

// ═══════════════════════════════════════════════════════════════════════════════
// FULL CLINICAL BATTERY — every test in sequence with 10 s Rest/Baseline periods
// ═══════════════════════════════════════════════════════════════════════════════
const BATTERY_SEQUENCE  = ['rsvp', 'nback', 'stroop', 'corsi', 'verbalFluency', 'aq10'];
const BATTERY_REST_SECS = 10;
const TEST_ABBR_FULL = {
  rsvp: 'RSVP Reading', nback: '2-Back Memory', stroop: 'Stroop Interference',
  corsi: 'Corsi Span', verbalFluency: 'Verbal Fluency (FAS)', aq10: 'AQ-10 Screen',
};

let batteryMode    = false;
let batteryQueue   = [];
let batteryTimeout = null;   // delay between a result and the rest period
let restTimeout    = null;   // rest-period countdown handle

function startBattery() {
  batteryMode  = true;
  batteryQueue = [...BATTERY_SEQUENCE];
  startTestByKey(batteryQueue.shift());   // first test runs immediately (no pre-rest)
}

// Called from showResult() ~2.6 s after each battery test completes.
function advanceBattery() {
  if (!batteryMode) return;
  if (batteryQueue.length === 0) {        // battery complete — leave final result on screen
    batteryMode = false;
    document.getElementById('btn-reset').disabled = false;
    return;
  }
  runRestPeriod(BATTERY_REST_SECS, () => startTestByKey(batteryQueue.shift()));
}

// 10-second Rest/Baseline screen with a live countdown, then `done()`.
function runRestPeriod(total, done) {
  showScreen('rest');
  window.brain.deactivateRegions();       // clear lobe glow → true resting baseline

  const nextEl = document.getElementById('rest-next');
  if (nextEl) nextEl.textContent = TEST_ABBR_FULL[batteryQueue[0]] ? `Next: ${TEST_ABBR_FULL[batteryQueue[0]]}` : '';

  const numEl = document.getElementById('rest-count');
  const barEl = document.getElementById('rest-bar');
  let remaining = total;
  const tick = () => {
    if (!batteryMode) return;             // aborted via Quit/reset
    if (numEl) numEl.textContent = remaining;
    if (barEl) barEl.style.width = `${(remaining / total) * 100}%`;
    if (remaining <= 0) { done(); return; }
    remaining--;
    restTimeout = setTimeout(tick, 1000);
  };
  tick();
}

// ── Timeline dashboard ────────────────────────────────────────────────────────
document.getElementById('btn-timeline').addEventListener('click', () => {
  renderDashboard();
  document.getElementById('dashboard-panel').classList.remove('hidden');
});
document.getElementById('btn-close-dashboard').addEventListener('click', () => {
  document.getElementById('dashboard-panel').classList.add('hidden');
});
document.getElementById('dashboard-panel').addEventListener('click', e => {
  if (e.target === e.currentTarget)
    document.getElementById('dashboard-panel').classList.add('hidden');
});

// ── Digital Brain Twin ────────────────────────────────────────────────────────
document.getElementById('btn-generate-twin').addEventListener('click', generateDigitalTwin);
document.getElementById('btn-exit-twin').addEventListener('click', exitDigitalTwin);
document.getElementById('btn-export-pdf').addEventListener('click', exportClinicalReport);

document.getElementById('btn-play-tour').addEventListener('click', () => {
  playClick();
  if (window.brain.isCinematicPlaying()) {
    window.brain.stopTwinCinematic();
    // onComplete callback restores the button state
  } else {
    const analyses = _lastTwinAnalyses;
    if (!analyses?.length) return;
    _startCinematic(analyses);
  }
});

document.getElementById('btn-user-profile').addEventListener('click', () => {
  window.brain.setBaselineMode(false);
  document.getElementById('btn-user-profile').classList.add('dth-active');
  document.getElementById('btn-healthy-baseline').classList.remove('dth-active');
});

document.getElementById('btn-healthy-baseline').addEventListener('click', () => {
  window.brain.setBaselineMode(true);
  document.getElementById('btn-healthy-baseline').classList.add('dth-active');
  document.getElementById('btn-user-profile').classList.remove('dth-active');
});

// ── Side-by-side Patient vs Healthy-Baseline comparison ──────────────────────
// Renders both brain states from the same viewpoint and lists the modelled
// structural/functional differences (grounded in the DTI/volumetry literature).
function _modeledDelta(z, status) {
  const a = Math.abs(Number(z) || 0);
  if (status === 'hyper') {
    const band = a >= 2.0 ? 'moderate' : 'mild';
    return `Modelled <span class="cmp-band-hyper">${band} increase</span> in short-range connectivity / regional activation vs baseline (supra-normal profile).`;
  }
  let band, faR, gmR, cls;
  if (a >= 2.5)      { band = 'marked';   faR = '≈10–16%'; gmR = '≈15–25%'; cls = 'cmp-band-marked'; }
  else if (a >= 2.0) { band = 'moderate'; faR = '≈7–12%';  gmR = '≈10–18%'; cls = 'cmp-band-moderate'; }
  else               { band = 'mild';     faR = '≈4–8%';   gmR = '≈6–12%';  cls = 'cmp-band-mild'; }
  return `Modelled <span class="${cls}">${band} reduction</span> vs baseline — tract FA ${faR}, regional grey-matter volume ${gmR}.`;
}

function _openBaselineComparison() {
  const cap = window.brain.captureComparison?.();
  if (cap) {
    document.getElementById('cmp-img-patient').src  = cap.patient;
    document.getElementById('cmp-img-baseline').src = cap.baseline;
  }
  const affected = (_lastTwinAnalyses || []).filter(a => a.status === 'deficit' || a.status === 'hyper');
  const list = document.getElementById('cmp-diffs-list');
  if (!affected.length) {
    list.innerHTML = `<div class="cmp-empty">No deficit or supra-normal pathways detected — the patient's modelled connectome matches the healthy baseline within normative limits.</div>`;
  } else {
    list.innerHTML = affected.map(a => {
      const zStr   = a.z != null ? `${a.z >= 0 ? '+' : ''}${a.z.toFixed(2)}` : '—';
      const metric = a.metric ? `${a.metric}: ${a.value}${a.unit || ''}` : (a.testName || '');
      return `<div class="cmp-row">
        <div class="cmp-tract">${a.tractName}<small>${a.testName}</small></div>
        <div class="cmp-metric">${metric}<br><span class="cmp-z">Z = ${zStr}</span> · ${a.status.toUpperCase()}</div>
        <div class="cmp-delta">${_modeledDelta(a.z, a.status)}</div>
      </div>`;
    }).join('');
  }
  document.getElementById('compare-overlay').classList.add('open');
}
function _closeBaselineComparison() { document.getElementById('compare-overlay').classList.remove('open'); }
document.getElementById('btn-compare-baseline')?.addEventListener('click', () => { playClick(); _openBaselineComparison(); });
document.getElementById('cmp-close')?.addEventListener('click', () => { playClick(); _closeBaselineComparison(); });
document.getElementById('compare-overlay')?.addEventListener('click', e => { if (e.target.id === 'compare-overlay') _closeBaselineComparison(); });

// ── Node / tract click — 3D raycaster → HUD card + clinical insight ──────────
// app.js raycasts the click (works in BOTH the hologram and anatomical views) and
// dispatches this event with the connected tract key.
window.addEventListener('tractClicked', e => {
  const key = e.detail.tractKey;
  _highlightTractCard(key);
  const a = _lastTwinAnalyses?.find(x => x.tractKey === key);
  if (a) _showClinicalInsight(a);
});

// ── Render-mode toggle: Functional Hologram ↔ Anatomical Scan ────────────────
// Synced across BOTH controls: the twin-HUD toggle and the always-visible global
// pill (available in the menu and the timeline dashboard, not just the twin).
function _setBrainViewMode(mode) {
  window.brain.setViewMode?.(mode);
  document.getElementById('btn-mode-hologram')?.classList.toggle('dth-active', mode === 'hologram');
  document.getElementById('btn-mode-anatomical')?.classList.toggle('dth-active', mode === 'anatomical');
  document.getElementById('vmg-hologram')?.classList.toggle('vmg-active', mode === 'hologram');
  document.getElementById('vmg-anatomical')?.classList.toggle('vmg-active', mode === 'anatomical');
}
['btn-mode-hologram', 'vmg-hologram'].forEach(id =>
  document.getElementById(id)?.addEventListener('click', () => { playClick(); _setBrainViewMode('hologram'); }));
['btn-mode-anatomical', 'vmg-anatomical'].forEach(id =>
  document.getElementById(id)?.addEventListener('click', () => { playClick(); _setBrainViewMode('anatomical'); }));

// ── §3 Surgical Planning Mode ────────────────────────────────────────────────
document.getElementById('btn-surgical-mode')?.addEventListener('click', () => {
  playClick();
  const on = !window.brain.getSurgicalMode?.();
  window.brain.setSurgicalMode?.(on);
  document.getElementById('btn-surgical-mode').classList.toggle('active', on);
  document.getElementById('lesion-tools')?.classList.toggle('hidden', !on);
  const c = document.getElementById('niivue-gl'); if (c) c.style.cursor = on ? 'crosshair' : '';
});
window.addEventListener('lesionDropped', e => {
  const { warnings, index } = e.detail;
  const panel = document.getElementById('lesion-warnings');
  if (!panel) return;
  panel.classList.remove('hidden');
  const card = document.createElement('div');
  if (!warnings.length) {
    card.className = 'lesion-card safe';
    card.innerHTML = `<div class="lesion-card-title">&#10003; Lesion ${index} — no eloquent tracts in field</div>` +
      `<div class="lesion-row">No modelled white-matter pathway intersects this resection zone.</div>`;
  } else {
    card.className = 'lesion-card';
    card.innerHTML = `<div class="lesion-card-title">&#9888; Lesion ${index} — ${warnings.length} tract${warnings.length > 1 ? 's' : ''} at risk</div>` +
      warnings.map(w => `<div class="lesion-row"><b>${w.name}</b> — ${w.deficit}</div>`).join('');
  }
  panel.prepend(card);
});
document.getElementById('btn-clear-lesions')?.addEventListener('click', () => {
  playClick(); window.brain.clearLesions?.();
  const p = document.getElementById('lesion-warnings'); if (p) { p.innerHTML = ''; p.classList.add('hidden'); }
});

// ── §4D Longitudinal projection slider ───────────────────────────────────────
const _progSlider = document.getElementById('progress-slider');
const _progReadout = document.getElementById('progress-readout');
function _fmtProgress(v) {
  if (v <= 0) return 'Current Day';
  const yrs = (v / 100) * 5;
  return yrs < 1 ? `+${Math.round(yrs * 12)} Months` : `+${yrs.toFixed(1)} Years`;
}
_progSlider?.addEventListener('input', () => {
  const v = +_progSlider.value;
  _progSlider.style.setProperty('--val', v + '%');
  if (_progReadout) _progReadout.textContent = _fmtProgress(v);
  window.brain.setProgression?.(v / 100);
});

// ── §2 On-demand NiiVue importer ─────────────────────────────────────────────
document.getElementById('btn-load-scan')?.addEventListener('click', () => { playClick(); window.brain.openNiiVue?.(); });
document.getElementById('btn-close-niivue')?.addEventListener('click', () => { playClick(); window.brain.closeNiiVue?.(); });
document.getElementById('niivue-file')?.addEventListener('change', e => { const f = e.target.files?.[0]; if (f) window.brain.loadNiiVueFile?.(f); });

// ═══════════════════════════════════════════════════════════════════════════════
// RSVP READING TEST
// ═══════════════════════════════════════════════════════════════════════════════
const rsvpWordEl  = document.getElementById('rsvp-word');
const rsvpBarEl   = document.getElementById('rsvp-bar');
const rsvpCountEl = document.getElementById('rsvp-count');

function runRSVP() {
  rsvpBarEl.style.width = '0%';
  rsvpWordEl.style.opacity = '';
  rsvpWordEl.classList.remove('pop');

  // Reflect the current adaptive presentation speed (escalates as the patient succeeds)
  const speedEl = document.querySelector('.rsvp-speed');
  if (speedEl) speedEl.textContent = `${rsvpWordMs} ms / word`;

  let index = 0;

  // Pre-roll delay lets the screen transition finish before words begin
  setTimeout(function flashNext() {
    // Abort the flash chain if the user has quit / switched tests — otherwise the
    // uncleared setTimeout chain would resurface the RSVP/question screen over the menu.
    if (currentTest !== 'rsvp') return;
    if (index >= rsvpPassage.words.length) {
      rsvpWordEl.style.opacity = '0';
      setTimeout(showRSVPQuestion, 380);
      return;
    }

    // Force CSS animation restart by removing → reflow → adding class
    rsvpWordEl.classList.remove('pop');
    rsvpWordEl.textContent = rsvpPassage.words[index];
    void rsvpWordEl.offsetWidth;
    rsvpWordEl.classList.add('pop');

    const pct = ((index + 1) / rsvpPassage.words.length) * 100;
    rsvpBarEl.style.width   = `${pct}%`;
    rsvpCountEl.textContent = `${index + 1} / ${rsvpPassage.words.length}`;

    index++;
    setTimeout(flashNext, rsvpWordMs);
  }, 280);
}

// ── Comprehension question ─────────────────────────────────────────────────────
function showRSVPQuestion() {
  if (currentTest !== 'rsvp') return;   // user quit during the final word — don't resurface
  showScreen('question');

  // Inject question text and rebuild choice buttons for the current passage
  document.querySelector('.question-text').textContent = rsvpPassage.question;
  document.getElementById('choices').innerHTML =
    rsvpPassage.answers
      .map(a => `<button class="choice-btn" data-answer="${a.correct ? 'correct' : 'wrong'}">${a.text}</button>`)
      .join('');

  const timerEl = document.getElementById('timer-val');
  timerEl.textContent = '0.0';
  timerEl.style.color = '#4ade80';

  // Record stimulus onset after the browser has committed the question screen to
  // pixels — eliminates JS dispatch latency from the comprehension RT measurement.
  requestAnimationFrame(() => {
    rsvpTimerStart = performance.now();
    rsvpTimerInterval = setInterval(() => {
      const elapsed = (performance.now() - rsvpTimerStart) / 1000;
      timerEl.textContent = elapsed.toFixed(1);
      timerEl.style.color =
        elapsed < 1.0 ? '#4ade80' :
        elapsed < 2.0 ? '#facc15' : '#f87171';
    }, 50);
  });
}

// Event delegation handles dynamically-rebuilt choice buttons
document.getElementById('choices').addEventListener('click', e => {
  const btn = e.target.closest('.choice-btn');
  if (btn && !btn.disabled) handleRSVPAnswer(btn);
});

function handleRSVPAnswer(chosenBtn) {
  if (!rsvpTimerStart) return;          // guard double-click

  clearInterval(rsvpTimerInterval);
  const elapsed   = performance.now() - rsvpTimerStart;
  rsvpTimerStart  = null;

  const isCorrect = chosenBtn.dataset.answer === 'correct';
  const isPerfect = isCorrect && elapsed < RSVP_FAST_MS;

  // Button visual feedback — always reveal the correct answer
  document.querySelectorAll('.choice-btn').forEach(b => {
    b.disabled = true;
    if (b.dataset.answer === 'correct') b.classList.add('btn-correct');
  });
  if (!isCorrect) chosenBtn.classList.add('btn-wrong');

  // Brain highlight
  window.brain.setRegionBrightness('readingGame', isPerfect ? 1.8 : 0.3);

  // Adaptive staircase: a correct read tightens the next presentation speed
  if (isCorrect) rsvpWordMs = Math.max(120, rsvpWordMs - 22);

  // Score: 100 for perfect; decaying for correct-but-slow; 0 for wrong.
  // A CORRECT answer floors at 60 so a right-but-unhurried read never maps below
  // the normative range (value 60 → z ≈ −0.6, "within normative limits") — reading
  // ACCURACY is preserved; only genuinely incorrect answers score in deficit range.
  const score = !isCorrect    ? 0 :
    elapsed < RSVP_FAST_MS   ? 100 :
    Math.max(60, Math.round(80 * Math.exp(-(elapsed - RSVP_FAST_MS) / 5000)));

  const secs = (elapsed / 1000).toFixed(2);

  const tag      = isPerfect ? '✦ PERFECT' : isCorrect ? '✓ CORRECT — SLOW' : '✗ INCORRECT';
  const tagColor = isPerfect ? '#b07a10'   : isCorrect ? '#1a7a4a'           : '#7a1a1a';

  const resultMsg = isPerfect
    ? `Correct answer in ${secs} s — under the 2-second threshold.`
    : isCorrect
      ? `Correct, but ${secs} s exceeded the 2-second threshold.`
      : `Incorrect after ${secs} s. The answer was "${rsvpPassage.answers.find(a => a.correct).text}".`;

  const brainMsg = isPerfect
    ? "Language networks firing at peak capacity — Wernicke's area decoded the sentence rapidly and Broca's area confirmed the syntactic target with minimal latency."
    : isCorrect
      ? "Correct comprehension, but extended processing time suggests higher cognitive load on the left temporal–frontal pathway. Sentence complexity may have slowed semantic retrieval."
      : "Comprehension error detected. RSVP pacing likely outpaced semantic binding in Wernicke's area. Language network activation has been reduced.";

  const colorClass = score === 100 ? 'perfect' : score >= 50 ? 'good' : 'poor';

  // Comprehension index (0–100) is the RSVP clinical metric → normative Z-engine
  setTimeout(() => finalizeClinical(score, { resultMsg, brainMsg }), 580);
}

// ═══════════════════════════════════════════════════════════════════════════════
// N-BACK MEMORY TEST
// ═══════════════════════════════════════════════════════════════════════════════

// ── Sequence generator ─────────────────────────────────────────────────────────
// Guarantees ~35 % target rate while preventing accidental 2-back matches on
// non-target positions.
function generateNBackSequence() {
  const seq = [];
  for (let i = 0; i < NBACK_LENGTH; i++) {
    if (i >= NBACK_N && Math.random() < 0.35) {
      seq.push(seq[i - NBACK_N]);    // deliberate 2-back match
    } else {
      const forbidden = i >= NBACK_N ? seq[i - NBACK_N] : null;
      let letter;
      do {
        letter = NBACK_ALPHABET[Math.floor(Math.random() * NBACK_ALPHABET.length)];
      } while (letter === forbidden); // ensure accidental match is impossible
      seq.push(letter);
    }
  }
  return seq;
}

// ── Trail dot helpers ──────────────────────────────────────────────────────────
function buildTrailDots() {
  const trail = document.getElementById('nback-trail');
  trail.innerHTML = '';
  for (let i = 0; i < NBACK_LENGTH; i++) {
    const dot = document.createElement('div');
    dot.className = 'trail-dot';
    dot.id = `dot-${i}`;
    trail.appendChild(dot);
  }
}

function setDot(i, state) { // state: 'active' | 'na' | 'correct' | 'miss' | 'fa'
  const dot = document.getElementById(`dot-${i}`);
  if (dot) dot.className = state === 'active' ? 'trail-dot active' : `trail-dot dot-${state}`;
}

// ── Game entry ────────────────────────────────────────────────────────────────
async function startNBack() {
  nbackAborted      = false;
  nbackSequence     = generateNBackSequence();
  nbackLetterMs     = NBACK_LETTER_MS;   // reset adaptive pace each run
  nbackResults      = new Array(NBACK_LENGTH).fill(null);
  nbackCurrentIndex = -1;
  nbackHasPressed   = false;

  // Reset all UI components
  buildTrailDots();
  document.getElementById('live-hits').textContent = '0';
  document.getElementById('live-fas').textContent  = '0';
  document.getElementById('live-acc').textContent  = '—';
  document.getElementById('nback-trial-num').textContent = '— / ' + NBACK_LENGTH;

  const matchBtn   = document.getElementById('btn-match');
  const nbackBox   = document.getElementById('nback-box');
  const letterEl   = document.getElementById('nback-letter');

  matchBtn.classList.remove('active', 'flash-hit', 'flash-fa');
  nbackBox.classList.remove('lit');
  letterEl.textContent = '';

  showScreen('nback');

  await wait(900);          // pre-roll pause so the user can read the cue text
  if (nbackAborted) return;

  await runNBackSequence(matchBtn, nbackBox, letterEl);
}

// ── Main letter loop ──────────────────────────────────────────────────────────
async function runNBackSequence(matchBtn, nbackBox, letterEl) {
  for (let i = 0; i < NBACK_LENGTH; i++) {
    if (nbackAborted) return;

    nbackCurrentIndex = i;
    nbackHasPressed   = false;

    const isEvaluable = i >= NBACK_N;
    const isTarget    = isEvaluable && nbackSequence[i] === nbackSequence[i - NBACK_N];

    // ── Show letter ──
    document.getElementById('nback-trial-num').textContent = `${i + 1} / ${NBACK_LENGTH}`;
    letterEl.textContent = nbackSequence[i];
    nbackBox.classList.add('lit');

    matchBtn.classList.remove('flash-hit', 'flash-fa');
    if (isEvaluable) matchBtn.classList.add('active');
    else             matchBtn.classList.remove('active');

    setDot(i, 'active');

    // ── Wait for stimulus window (adaptive pace) ──
    await wait(nbackLetterMs);
    if (nbackAborted) return;

    // ── Score this trial ──
    if (isEvaluable) {
      const pressed = nbackHasPressed;
      const hit  = isTarget  &&  pressed;
      const fa   = !isTarget &&  pressed;
      const miss = isTarget  && !pressed;
      const cr   = !isTarget && !pressed;

      nbackResults[i] = { isTarget, pressed, hit, fa, miss, cr };

      // Trail dot outcome
      setDot(i, (hit || cr) ? 'correct' : miss ? 'miss' : 'fa');

      // Live stats update
      const done    = nbackResults.slice(NBACK_N).filter(Boolean);
      const totHits = done.filter(r => r.hit).length;
      const totFAs  = done.filter(r => r.fa).length;
      const acc     = done.length > 0
        ? Math.round(done.filter(r => r.hit || r.cr).length / done.length * 100)
        : 0;

      document.getElementById('live-hits').textContent = totHits;
      document.getElementById('live-fas').textContent  = totFAs;
      document.getElementById('live-acc').textContent  = done.length ? `${acc}%` : '—';

      // Adaptive pacing: accelerate when the patient is coping, ease off if struggling
      if (acc >= 80)      nbackLetterMs = Math.max(650,  nbackLetterMs - 70);
      else if (acc < 55)  nbackLetterMs = Math.min(1300, nbackLetterMs + 70);

    } else {
      nbackResults[i] = null;
      setDot(i, 'na');       // first N positions are not evaluable
    }

    // ── Blank inter-stimulus interval ──
    matchBtn.classList.remove('active', 'flash-hit', 'flash-fa');
    nbackBox.classList.remove('lit');
    letterEl.textContent = '';

    await wait(NBACK_GAP_MS);
    if (nbackAborted) return;
  }

  await wait(300);
  if (!nbackAborted) showNBackResult();
}

// ── MATCH button ──────────────────────────────────────────────────────────────
document.getElementById('btn-match').addEventListener('click', () => {
  const matchBtn = document.getElementById('btn-match');
  if (!matchBtn.classList.contains('active') || nbackHasPressed) return;

  nbackHasPressed = true;

  const i        = nbackCurrentIndex;
  const isTarget = i >= NBACK_N && nbackSequence[i] === nbackSequence[i - NBACK_N];

  matchBtn.classList.add(isTarget ? 'flash-hit' : 'flash-fa');
});

// ── N-Back result ─────────────────────────────────────────────────────────────
function showNBackResult() {
  const evaluated   = nbackResults.slice(NBACK_N).filter(Boolean);
  const hits        = evaluated.filter(r => r.hit).length;
  const misses      = evaluated.filter(r => r.miss).length;
  const fas         = evaluated.filter(r => r.fa).length;
  const crs         = evaluated.filter(r => r.cr).length;
  const targets     = hits + misses;          // evaluable target trials
  const nonTargets  = fas + crs;              // evaluable non-target trials

  // True d′ via Hautus (2004) correction to handle hit/FA rates of 0 or 1.
  // Corrected rates: (count + 0.5) / (total + 1) — avoids ±∞ from probit.
  const hrCorr  = (hits + 0.5) / (targets    + 1);
  const farCorr = (fas  + 0.5) / (nonTargets + 1);
  const dprime  = parseFloat((_normInv(hrCorr) - _normInv(farCorr)).toFixed(2));

  // Pass/fail at d′ ≥ 1.38 ≈ NBACK_PASS_PCT threshold mapped to new scale
  const passThreshold = 1.38;
  window.brain.setRegionBrightness('nBackGame', dprime >= passThreshold ? 1.8 : 0.3);

  const resultMsg =
    `d′ = ${dprime} · ${hits} hit${hits !== 1 ? 's' : ''} · ${misses} miss${misses !== 1 ? 'es' : ''} · ` +
    `${fas} FA · ${crs} CR (${targets} targets / ${evaluated.length} trials)`;

  const brainMsg = dprime >= passThreshold
    ? 'The dorsolateral prefrontal cortex and posterior parietal cortex maintained active 2-back representations efficiently, with high d′ separability between targets and foils.'
    : 'Low d′ indicates the signal was poorly separated from noise — elevated false alarms or misses suggest frontoparietal load under the continuous 2-back stream.';

  // d′ is the N-Back clinical metric fed to the normative Z-engine.
  finalizeClinical(dprime, { resultMsg, brainMsg });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED RESULT SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
const CITATIONS = {
  stroop: 'Adleman et al. (2002). Prefrontal cortex and anterior cingulate functional development. NeuroImage.',
  nback:  'Owen et al. (2005). N-back working memory paradigm: A meta-analysis. Hum Brain Mapp.',
  corsi:  'Kessels et al. (2000). The Corsi Block-Tapping Task: Standardization and normative data. Appl Neuropsychol.',
  verbalFluency: 'Catani et al. (2013). A novel frontal pathway underlies verbal fluency in primary progressive aphasia. Brain.',
  aq10: 'Allison, Auyeung & Baron-Cohen (2012). Toward brief “Red Flags” for autism screening: the AQ-10. JAACAP, 51(2).',
  goNoGo: 'Aron, Robbins & Poldrack (2014). Inhibition and the right inferior frontal cortex: one decade on. Trends Cogn Sci, 18(4).',
  trailsB: 'Sánchez-Cubillo et al. (2009). Construct validity of the Trail Making Test. J Int Neuropsychol Soc, 15(3).',
};

// ── Normative Z-score finalizer ────────────────────────────────────────────────
// Every test funnels its RAW clinical metric through here. We classify it against
// the normative Mean/SD (or AQ-10 cut-off), derive a 0–100 normative-performance
// display score, build the clinical tag, and record the raw value + Z for the twin.
// Published test-retest reliability estimates (internal consistency α / r_tt).
// Used to compute the 95% measurement CI around each z-score.
const TEST_RELIABILITY = {
  nback: 0.74, stroop: 0.81, corsi: 0.78,
  rsvp: 0.70, verbalFluency: 0.85, fingerTapping: 0.90,
};

function finalizeClinical(value, { resultMsg = '', brainMsg = '', lowEffort = null } = {}) {
  // Guard against delayed finalizers firing after the user has quit to the menu
  // (several tests call this from a setTimeout). resetToMenu() nulls currentTest,
  // so this cleanly prevents a stray result screen / phantom record on quick quit.
  if (currentTest == null) return;

  // Unscored practice round — show brief feedback then restart as real test.
  if (_inPractice) {
    const isCorrect = currentTest === 'stroop'
      ? value < (NORMATIVE.stroop?.mean ?? 200)   // lower interference = correct direction
      : value > 0;
    _showPracticeResult(isCorrect);
    return;
  }

  // Color vision deficit invalidates the Stroop interference paradigm.
  if (currentTest === 'stroop' && userProfile?.colorBlind) {
    showResult(0, '⚠ TEST INVALIDATED — COLOR VISION DEFICIT', '#8B4000',
      'Stroop Task INVALIDATED: the ink-color interference paradigm requires intact color discrimination. This score is excluded from the normative analysis and clinical report.',
      'Colorblindness renders congruent/incongruent ink-word conflict non-discriminable, making the RT interference delta a non-diagnostic metric for this patient.',
      'poor', { value: null, z: null });
    return;
  }

  const c = classifyAdjusted(currentTest, value);
  const n = NORMATIVE[currentTest] || {};

  let displayScore;
  if (c.zc != null) displayScore = Math.max(0, Math.min(100, Math.round(50 + c.zc * 20)));
  else              displayScore = Math.round((value / 10) * 100);

  let tag, tagColor, colorClass;
  if (c.status === 'deficit')           { tag = '✗ CLINICAL DEFICIT (z ≤ −1.5)';  tagColor = '#7a1a1a'; colorClass = 'poor'; }
  else if (c.status === 'hyper')        { tag = '✦ SUPRA-NORMAL (z ≥ +1.5)';       tagColor = '#5B2B8A'; colorClass = 'perfect'; }
  else if (c.status === 'atypical')     { tag = '◆ SCREEN POSITIVE';               tagColor = '#8e44ad'; colorClass = 'poor'; }
  else if (c.zc != null && c.zc >= 1.0){ tag = '✦ ABOVE NORMATIVE MEAN';           tagColor = '#b07a10'; colorClass = 'perfect'; }
  else                                  { tag = '✓ WITHIN NORMATIVE RANGE';         tagColor = '#1a7a4a'; colorClass = 'good'; }

  // 95% CI on the z-score, derived from test-retest reliability (SEM = √(1−r_tt)).
  const rel = TEST_RELIABILITY[currentTest] ?? 0.80;
  const sem = Math.sqrt(1 - rel);   // SEM in z-score units
  let ciTxt = '';
  if (c.z != null) {
    const lo = (c.z - 1.96 * sem).toFixed(1);
    const hi = (c.z + 1.96 * sem).toFixed(1);
    ciTxt = ` · 95% CI [${lo >= 0 ? '+' : ''}${lo}, ${hi >= 0 ? '+' : ''}${hi}]`;
  }

  const zTxt = c.z != null
    ? `z = ${c.z >= 0 ? '+' : ''}${c.z.toFixed(2)}${ciTxt}`
    : `${value}/10 vs cut-off ≥ ${n.cutoff}`;
  const metricLine = `${n.metric}: ${value}${n.unit || ''} · ${zTxt}`;

  showResult(displayScore, tag, tagColor, `${metricLine}. ${resultMsg}`, brainMsg, colorClass, { value, z: c.z, lowEffort });
}

function showResult(score, tag, tagColor, resultMsg, brainMsg, colorClass, clinical = {}) {
  userTimelineResults.push({
    date: new Date(), test: currentTest, score,
    value: clinical.value ?? score, z: clinical.z ?? null,
  });
  saveResults();
  showScreen('result');
  document.getElementById('panel').classList.add('clinical-mode');

  const scoreEl = document.getElementById('score-num');
  scoreEl.textContent = score;
  scoreEl.classList.remove('reveal', 'perfect', 'good', 'poor');
  void scoreEl.offsetWidth;  // reflow so animation fires on replay
  scoreEl.classList.add('reveal', colorClass);

  const tagEl = document.getElementById('score-tag');
  tagEl.textContent = tag;
  tagEl.style.color = tagColor;

  document.getElementById('result-msg').textContent = resultMsg;
  document.getElementById('brain-msg').textContent  = brainMsg;

  const citationBlock = document.getElementById('citation-block');
  const citation = CITATIONS[currentTest];
  if (citation) {
    document.getElementById('citation-text').textContent = citation;
    citationBlock.classList.remove('hidden');
  } else {
    citationBlock.classList.add('hidden');
  }

  // Effort-validity indicator. Prefer an explicit per-test engagement signal
  // (e.g. Go-hit rate for Go/No-Go, inactivity time for TMT-B) supplied by the
  // finalizer. Only fall back to the generic "near-zero score" heuristic for the
  // classic performance tests — NEVER for cut-off screeners (AQ-10), the TBI
  // tests, or RSVP. RSVP is validated by comprehension ACCURACY (did they answer
  // correctly), not by the numeric score: a correct-but-slow read yields a low
  // comprehension-index score yet reflects a genuinely engaged patient, so the
  // score-based heuristic would misfire.
  const validityEl = document.getElementById('validity-warning');
  if (validityEl) {
    const SCORE_HEURISTIC_TESTS = ['nback', 'stroop', 'corsi', 'verbalFluency', 'fingerTapping'];
    const lowEffort = clinical.lowEffort != null
      ? clinical.lowEffort
      : (SCORE_HEURISTIC_TESTS.includes(currentTest) && score <= 8);
    validityEl.classList.toggle('hidden', !lowEffort);
  }

  // Full Clinical Battery: pause on the result briefly, then rest → next test.
  if (batteryMode) {
    document.getElementById('btn-reset').disabled = true;
    clearTimeout(batteryTimeout);
    batteryTimeout = setTimeout(advanceBattery, 2600);
  } else {
    document.getElementById('btn-reset').disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STROOP TASK
// Displays a color word printed in a (usually) conflicting ink color.
// The player must select the ink color, not the word.
// Correct answer → neural connection fires (occipital → frontal) + neuroplasticity pulse.
// ═══════════════════════════════════════════════════════════════════════════════

const STROOP_COLORS = ['red', 'blue', 'green', 'yellow', 'purple'];
const STROOP_COLOR_HEX = {
  red:    '#e74c3c',
  blue:   '#3498db',
  green:  '#27ae60',
  yellow: '#e6bb00',
  purple: '#9b59b6',
};
const STROOP_BLOCK_SIZE  = 30;    // 30 congruent + 30 incongruent (true interference design)
const STROOP_DEADLINE_MS = 3000;  // fixed response window (clean comparable RTs)
const STROOP_FEEDBACK_MS = 450;   // brief feedback between trials

let stroopTrials      = [];   // [{ word, inkColor, isIncongruent, block }]
let stroopResults     = [];   // [{ correct, rt, block }]
let stroopTrialIndex  = -1;
let stroopTrialStart  = 0;
let stroopWaiting     = false;
let stroopAborted     = false;
let stroopNextTimeout = null;
// (stroopDeadlineTimeout is declared once in the adaptive-state block near the top)

// ── Block-design sequence: 30 fully-congruent, then 30 fully-incongruent ──────
function generateStroopTrials() {
  const trials = [];
  for (let i = 0; i < STROOP_BLOCK_SIZE; i++) {
    const word = STROOP_COLORS[Math.floor(Math.random() * STROOP_COLORS.length)];
    trials.push({ word, inkColor: word, isIncongruent: false, block: 'congruent' });
  }
  for (let i = 0; i < STROOP_BLOCK_SIZE; i++) {
    const word   = STROOP_COLORS[Math.floor(Math.random() * STROOP_COLORS.length)];
    const others = STROOP_COLORS.filter(c => c !== word);
    const ink    = others[Math.floor(Math.random() * others.length)];
    trials.push({ word, inkColor: ink, isIncongruent: true, block: 'incongruent' });
  }
  return trials;
}

// ── UI helpers ────────────────────────────────────────────────────────────────
const stroopWordEl     = document.getElementById('stroop-word');
const stroopFeedbackEl = document.getElementById('stroop-feedback');
const stroopBarEl      = document.getElementById('stroop-bar');
const stroopChoicesEl  = document.getElementById('stroop-choices');

function _resetStroopButtons(disabled = false) {
  stroopChoicesEl.querySelectorAll('.stroop-btn').forEach(b => {
    b.disabled = disabled;
    b.classList.remove('btn-correct', 'btn-wrong');
  });
}

function _showStroopTrial(trial) {
  stroopWordEl.textContent = trial.word.toUpperCase();
  stroopWordEl.style.color = STROOP_COLOR_HEX[trial.inkColor];
  _resetStroopButtons(false);
  stroopFeedbackEl.textContent = '';
  stroopFeedbackEl.style.color = '';

  // Reset bar synchronously so there is no flash during the inter-trial interval.
  stroopBarEl.style.transition = 'none';
  stroopBarEl.style.width      = '100%';
  void stroopBarEl.offsetWidth;

  clearTimeout(stroopDeadlineTimeout);

  // Record stimulus onset and arm the deadline only after the browser has painted
  // the stimulus word — eliminates event-loop dispatch latency from RT measurements.
  requestAnimationFrame(() => {
    stroopTrialStart = performance.now();
    stroopBarEl.style.transition = `width ${STROOP_DEADLINE_MS}ms linear`;
    stroopBarEl.style.width      = '0%';
    stroopDeadlineTimeout = setTimeout(_stroopTimeout, STROOP_DEADLINE_MS);
  });
}

function _stroopUpdateLiveStats() {
  const done  = stroopResults.length;
  const hits  = stroopResults.filter(r => r.correct).length;
  const avgRT = done ? Math.round(stroopResults.reduce((s, r) => s + r.rt, 0) / done) : 0;
  document.getElementById('stroop-correct').textContent = hits;
  document.getElementById('stroop-rt').textContent      = avgRT || '—';
  document.getElementById('stroop-acc').textContent     = done ? `${Math.round(hits / done * 100)}%` : '—';
}

// Deadline expired with no response — score as an error at the deadline RT.
function _stroopTimeout() {
  if (stroopAborted || stroopWaiting || stroopTrialIndex < 0) return;
  const trial = stroopTrials[stroopTrialIndex];

  stroopResults.push({ correct: false, rt: STROOP_DEADLINE_MS, block: trial.block });

  _resetStroopButtons(true);
  stroopChoicesEl.querySelectorAll(`.stroop-btn[data-color="${trial.inkColor}"]`)
    .forEach(b => b.classList.add('btn-correct'));
  stroopFeedbackEl.textContent = '⏱ Too slow';
  stroopFeedbackEl.style.color = '#e67e22';

  _stroopUpdateLiveStats();
  window.brain.setRegionBrightness('stroopTask', 0.4);

  stroopWaiting = true;
  stroopNextTimeout = setTimeout(() => {
    stroopWaiting = false;
    if (!stroopAborted) stroopNextTrial();
  }, STROOP_FEEDBACK_MS);
}

// ── Game entry ────────────────────────────────────────────────────────────────
function startStroop() {
  stroopAborted    = false;
  stroopTrials     = generateStroopTrials();
  stroopResults    = [];
  stroopTrialIndex = -1;

  document.getElementById('stroop-correct').textContent = '0';
  document.getElementById('stroop-rt').textContent      = '—';
  document.getElementById('stroop-acc').textContent     = '—';
  document.getElementById('stroop-trial-num').textContent = 'Congruent block';
  stroopBarEl.style.width = '0%';
  stroopWordEl.textContent = '—';
  stroopWordEl.style.color = '#e8f0ff';
  stroopFeedbackEl.textContent = '';
  _resetStroopButtons(true);

  showScreen('stroop');
  stroopNextTimeout = setTimeout(stroopNextTrial, 900);
}

// ── Advance to next trial ─────────────────────────────────────────────────────
function stroopNextTrial() {
  if (stroopAborted) return;
  stroopTrialIndex++;
  if (stroopTrialIndex >= stroopTrials.length) { showStroopResult(); return; }

  const trial  = stroopTrials[stroopTrialIndex];
  const within = stroopTrialIndex < STROOP_BLOCK_SIZE
    ? stroopTrialIndex + 1
    : stroopTrialIndex + 1 - STROOP_BLOCK_SIZE;
  document.getElementById('stroop-trial-num').textContent =
    `${trial.block === 'congruent' ? 'Congruent' : 'Incongruent'} ${within} / ${STROOP_BLOCK_SIZE}`;

  _showStroopTrial(trial);
}

// ── Answer handler ────────────────────────────────────────────────────────────
stroopChoicesEl.addEventListener('click', e => {
  const btn = e.target.closest('.stroop-btn');
  if (!btn || btn.disabled || stroopWaiting || stroopTrialIndex < 0) return;

  // Stop the deadline countdown and freeze the bar at its current position
  clearTimeout(stroopDeadlineTimeout);
  stroopBarEl.style.transition = 'none';
  stroopBarEl.style.width      = getComputedStyle(stroopBarEl).width;

  const rt      = performance.now() - stroopTrialStart;
  const chosen  = btn.dataset.color;
  const trial   = stroopTrials[stroopTrialIndex];
  const correct = chosen === trial.inkColor;

  stroopResults.push({ correct, rt, block: trial.block });

  // Freeze all buttons; reveal outcome
  _resetStroopButtons(true);
  btn.classList.add(correct ? 'btn-correct' : 'btn-wrong');
  if (!correct) {
    stroopChoicesEl.querySelectorAll(`.stroop-btn[data-color="${trial.inkColor}"]`)
      .forEach(b => b.classList.add('btn-correct'));
  }

  stroopFeedbackEl.textContent = correct ? '✓ Correct' : `✗ It was ${trial.inkColor.toUpperCase()}`;
  stroopFeedbackEl.style.color = correct ? '#27ae60' : '#e74c3c';

  _stroopUpdateLiveStats();

  // ── Brain response (rendering + audio hooks preserved) ────────────────────
  if (correct) {
    // Conflict-resolution pathway: visual → ACC (conflict detection) → PFC (inhibitory control)
    window.brain.drawConnection('leftOccipital',  'anteriorCingulate');
    window.brain.drawConnection('rightOccipital', 'anteriorCingulate');
    setTimeout(() => {
      window.brain.drawConnection('anteriorCingulate', 'leftFrontal');
      window.brain.drawConnection('anteriorCingulate', 'rightFrontal');
    }, 420);
    // Frontal lobe grows slightly to show plastic reinforcement
    window.brain.triggerNeuroplasticity('leftFrontal',  1.045, 1200);
    window.brain.triggerNeuroplasticity('rightFrontal', 1.045, 1200);
    window.brain.setRegionBrightness('stroopTask', 1.8);
  } else {
    window.brain.setRegionBrightness('stroopTask', 0.4);
  }

  stroopWaiting = true;
  stroopNextTimeout = setTimeout(() => {
    stroopWaiting = false;
    if (!stroopAborted) stroopNextTrial();
  }, STROOP_FEEDBACK_MS);
});

// ── Result screen ─────────────────────────────────────────────────────────────
function showStroopResult() {
  stroopBarEl.style.width = '100%';
  window.brain.clearConnections();

  const meanRT = block => {
    const rts = stroopResults.filter(r => r.block === block && r.correct).map(r => r.rt);
    return rts.length ? rts.reduce((s, r) => s + r, 0) / rts.length : STROOP_DEADLINE_MS;
  };
  const congRT = Math.round(meanRT('congruent'));
  const incRT  = Math.round(meanRT('incongruent'));
  const interference = incRT - congRT;        // Stroop interference cost (ms) — the metric

  const hits = stroopResults.filter(r => r.correct).length;
  const acc  = stroopResults.length ? Math.round(hits / stroopResults.length * 100) : 0;
  window.brain.setRegionBrightness('stroopTask', interference <= NORMATIVE.stroop.mean ? 1.8 : 0.3);

  const resultMsg =
    `Congruent ${congRT} ms vs Incongruent ${incRT} ms → interference ${interference} ms · ${acc}% accuracy.`;

  const brainMsg = interference <= NORMATIVE.stroop.mean
    ? 'The anterior cingulate cortex and dorsolateral prefrontal cortex resolved word–colour conflict with a small RT cost, indicating efficient cingulo-frontal inhibitory control.'
    : 'A large interference RT cost indicates the cingulo-frontal network was slowed by word–colour conflict — the hallmark of reduced top-down inhibitory control.';

  // Interference RT delta (ms) is the Stroop clinical metric → normative Z-engine.
  finalizeClinical(interference, { resultMsg, brainMsg });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRACTICE ROUND IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════════════

// N-Back practice: 10-trial N=1 sequence — easier load, still demonstrates the task.
function _startNBackPractice() {
  nbackAborted = false;
  const practiceLen = 10;
  nbackSequence     = (() => {
    const seq = [];
    for (let i = 0; i < practiceLen; i++) {
      if (i >= 1 && Math.random() < 0.35) seq.push(seq[i - 1]);
      else {
        const prev = i >= 1 ? seq[i - 1] : null;
        let l;
        do { l = NBACK_ALPHABET[Math.floor(Math.random() * NBACK_ALPHABET.length)]; } while (l === prev);
        seq.push(l);
      }
    }
    return seq;
  })();
  nbackResults      = new Array(practiceLen).fill(null);
  nbackCurrentIndex = -1;
  nbackHasPressed   = false;
  nbackLetterMs     = NBACK_LETTER_MS;

  const matchBtn = document.getElementById('btn-match');
  const nbackBox = document.getElementById('nback-box');
  const letterEl = document.getElementById('nback-letter');
  matchBtn.classList.remove('active', 'flash-hit', 'flash-fa');
  nbackBox.classList.remove('lit');
  letterEl.textContent = '';

  // Rebuild dots for practice length
  const trail = document.getElementById('nback-trail');
  trail.innerHTML = '';
  for (let i = 0; i < practiceLen; i++) {
    const dot = document.createElement('div'); dot.className = 'trail-dot'; dot.id = `dot-${i}`; trail.appendChild(dot);
  }
  document.getElementById('live-hits').textContent = '0';
  document.getElementById('live-fas').textContent  = '0';
  document.getElementById('live-acc').textContent  = '—';
  document.getElementById('nback-trial-num').textContent = '— / ' + practiceLen;

  showScreen('nback');

  // Run N=1 practice loop then call _finishPractice
  (async () => {
    await wait(900);
    if (nbackAborted) return;
    for (let i = 0; i < practiceLen; i++) {
      if (nbackAborted) return;
      nbackCurrentIndex = i; nbackHasPressed = false;
      const isTarget = i >= 1 && nbackSequence[i] === nbackSequence[i - 1];
      document.getElementById('nback-trial-num').textContent = `${i + 1} / ${practiceLen}`;
      letterEl.textContent = nbackSequence[i];
      nbackBox.classList.add('lit');
      matchBtn.classList.remove('flash-hit', 'flash-fa');
      if (i >= 1) matchBtn.classList.add('active'); else matchBtn.classList.remove('active');
      setDot(i, 'active');
      await wait(nbackLetterMs);
      if (nbackAborted) return;
      if (i >= 1) {
        const hit = isTarget && nbackHasPressed;
        setDot(i, (hit || (!isTarget && !nbackHasPressed)) ? 'correct' : isTarget ? 'miss' : 'fa');
      } else { setDot(i, 'na'); }
      matchBtn.classList.remove('active', 'flash-hit', 'flash-fa');
      nbackBox.classList.remove('lit'); letterEl.textContent = '';
      await wait(NBACK_GAP_MS);
    }
    await wait(300);
    if (!nbackAborted) _showPracticeResult(true);
  })();
}

// Stroop practice: 3 congruent + 3 incongruent trials — demonstrates both block types.
function _startStroopPractice() {
  stroopAborted    = false;
  stroopResults    = [];
  stroopTrialIndex = -1;
  const practiceTrials = [];
  for (let i = 0; i < 3; i++) {
    const w = STROOP_COLORS[Math.floor(Math.random() * STROOP_COLORS.length)];
    practiceTrials.push({ word: w, inkColor: w, isIncongruent: false, block: 'congruent' });
  }
  for (let i = 0; i < 3; i++) {
    const w = STROOP_COLORS[Math.floor(Math.random() * STROOP_COLORS.length)];
    const others = STROOP_COLORS.filter(c => c !== w);
    const ink = others[Math.floor(Math.random() * others.length)];
    practiceTrials.push({ word: w, inkColor: ink, isIncongruent: true, block: 'incongruent' });
  }
  stroopTrials = practiceTrials;

  document.getElementById('stroop-correct').textContent = '0';
  document.getElementById('stroop-rt').textContent      = '—';
  document.getElementById('stroop-acc').textContent     = '—';
  document.getElementById('stroop-trial-num').textContent = 'Practice';
  stroopBarEl.style.width = '0%';
  stroopWordEl.textContent = '—';
  stroopWordEl.style.color = '#e8f0ff';
  stroopFeedbackEl.textContent = '';
  _resetStroopButtons(true);
  showScreen('stroop');

  // Override showStroopResult to redirect to practice finish
  stroopNextTimeout = setTimeout(() => {
    const _origLen = stroopTrials.length;
    // Monkey-patch: after practiceTrials.length trials, call _showPracticeResult
    const _origShowStroopResult = showStroopResult;
    showStroopResult = function() {
      showStroopResult = _origShowStroopResult;
      _showPracticeResult(true);
    };
    stroopNextTrial();
  }, 900);
}

// Corsi practice: one forward trial at span 3 — shows what tapping blocks means.
function _startCorsiPractice() {
  corsiAborted = false; corsiAcceptingInput = false;
  corsiTimeouts.forEach(clearTimeout); corsiTimeouts = [];
  corsiInput = [];
  buildCorsiBoard();
  document.getElementById('corsi-best').textContent = '—';
  document.getElementById('corsi-acc').textContent  = '—';
  showScreen('corsi');

  const practiceSeq = (() => {
    const idx = [...Array(CORSI_BLOCKS).keys()];
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return idx.slice(0, 3);
  })();

  document.getElementById('corsi-span').textContent  = 3;
  document.getElementById('corsi-trial').textContent = 1;

  // Playback 3 blocks then accept one response; finish practice regardless of correctness.
  let t = 700;
  practiceSeq.forEach(bi => {
    corsiTimeouts.push(setTimeout(() => { if (!corsiAborted) _corsiFlash(bi, 'corsi-lit', CORSI_FLASH_MS); playClick(); }, t));
    t += CORSI_FLASH_MS + CORSI_GAP_MS;
  });
  corsiTimeouts.push(setTimeout(() => {
    if (corsiAborted) return;
    corsiAcceptingInput = true;
    _corsiSetPhase('Recall · Practice');
    document.getElementById('corsi-hint').textContent = 'Tap the blocks in the same order — 3 blocks';
    document.getElementById('corsi-board').classList.add('recall-mode');
    // Wait for the player to tap all 3 OR 8 s timeout, then finish practice
    let tapped = 0;
    const origHandle = handleCorsiClick;
    handleCorsiClick = function(idx) {
      playClick(); _corsiFlash(idx, 'corsi-tap', 260); tapped++;
      if (tapped >= 3) { handleCorsiClick = origHandle; corsiAcceptingInput = false; _showPracticeResult(true); }
    };
    corsiTimeouts.push(setTimeout(() => { handleCorsiClick = origHandle; corsiAcceptingInput = false; _showPracticeResult(true); }, 8000));
  }, t + 150));
}

// FTT touch tap — mirrors the Space keydown handler for touch screens.
document.getElementById('ftt-tap-btn')?.addEventListener('pointerdown', e => {
  e.preventDefault();
  if (currentTest !== 'fingerTapping' || fttAborted) return;
  if (!fttActive && fttStartTime === 0) {
    fttActive    = true;
    fttStartTime = performance.now();
    document.getElementById('ftt-phase').textContent          = 'TAPPING';
    document.getElementById('ftt-instructions').style.opacity = '0';
    document.getElementById('ftt-tap-btn').textContent        = 'TAP';
    document.getElementById('ftt-counter').classList.add('tapping');
    fttAnimFrame = requestAnimationFrame(_fttTick);
  }
  if (!fttActive) return;
  fttTaps++;
  playClick();
  document.getElementById('ftt-counter').textContent = fttTaps;
});

// ═══════════════════════════════════════════════════════════════════════════════
// RESET → BACK TO MENU
// ═══════════════════════════════════════════════════════════════════════════════
document.getElementById('btn-reset').addEventListener('click', resetToMenu);

function resetToMenu() {
  // Stop RSVP timer if running
  clearInterval(rsvpTimerInterval);
  rsvpTimerInterval = null;
  rsvpTimerStart    = null;

  // Abort N-Back async loop if running
  nbackAborted = true;
  clearTimeout(nbackLoopTimeout);
  nbackLoopTimeout  = null;
  nbackCurrentIndex = -1;

  // Abort Stroop if running
  stroopAborted = true;
  clearTimeout(stroopNextTimeout);
  clearTimeout(stroopDeadlineTimeout);
  stroopNextTimeout = null;

  // Abort Corsi if running
  corsiAborted = true;
  corsiAcceptingInput = false;
  corsiTimeouts.forEach(clearTimeout);
  corsiTimeouts = [];

  // Abort Verbal Fluency if running
  fluencyActive = false;
  clearInterval(fluencyTimer);
  fluencyTimer = null;

  // Abort AQ-10 if running
  aq10Active = false;

  // Abort FTT if running
  fttAborted = true;
  fttActive  = false;
  if (fttAnimFrame) { cancelAnimationFrame(fttAnimFrame); fttAnimFrame = null; }

  // Abort Go/No-Go if running
  gngAborted = true; gngActive = false;
  gngTimeouts.forEach(clearTimeout); gngTimeouts = [];

  // Abort Trail Making if running
  tmtAborted = true; tmtActive = false;
  if (tmtTimerRAF) { cancelAnimationFrame(tmtTimerRAF); tmtTimerRAF = null; }

  // Abort the Full Clinical Battery if running
  batteryMode = false;
  clearTimeout(batteryTimeout);
  clearTimeout(restTimeout);
  document.getElementById('btn-reset').disabled = false;

  currentTest = null;
  _inPractice = false;
  _showPracticeBadge(false);

  // Restore brain to neutral (clear connections + glow)
  window.brain.deactivateRegions();
  window.brain.clearConnections();

  // Tidy up lingering UI state
  rsvpWordEl.classList.remove('pop');
  rsvpWordEl.style.opacity = '';
  rsvpBarEl.style.width    = '0%';
  document.getElementById('score-num').classList.remove('reveal', 'perfect', 'good', 'poor');

  document.getElementById('panel').classList.remove('clinical-mode');
  showScreen('menu');
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIGITAL BRAIN TWIN
// ═══════════════════════════════════════════════════════════════════════════════
let _lastTwinAnalyses      = null;  // kept so "Play Tour" can replay after first run
let _lastTwinValues        = null;  // raw clinical values behind the twin (radar + PDF reuse)
let _tractHighlightTimeout = null;  // auto-clears card highlight after 3 s

function generateDigitalTwin() {
  playClick();
  // Aggregate most recent score per test type
  // Aggregate the most recent RAW clinical value per test (drives the Z-engine).
  const values = {};
  userTimelineResults.forEach(r => { values[r.test] = r.value ?? r.score; });
  _lastTwinValues = values;

  if (Object.keys(values).length === 0) {
    document.getElementById('dashboard-panel').classList.add('hidden');
    alert('Complete at least one test before generating your Digital Brain Twin.');
    return;
  }

  // Close dashboard
  document.getElementById('dashboard-panel').classList.add('hidden');

  // Transition scene to twin mode
  window.brain.setSceneBackground(0x030810);
  window.brain.setSceneLightingFactor(0.16);
  window.brain.setBaselineGhostVisible(false);
  window.brain.setGridVisible(false);
  window.brain.deactivateRegions();
  window.brain.clearConnections();
  // Slice the cortex open to reveal the glowing subcortical structures + tracts
  window.brain.setCortexCutaway(true);

  // Draw tracts and retrieve analysis data
  const analyses = window.brain.drawDigitalTwin(values);
  _lastTwinAnalyses = analyses;

  // Build HUD cards
  const tractsEl = document.getElementById('dth-tracts');
  tractsEl.innerHTML = analyses.map(a => {
    const badgeLabel = a.status === 'deficit'   ? '&#9888; Deficit / Hypo-connectivity'
                     : a.status === 'hyper'     ? '&#9650; Hyper-connectivity'
                     : a.status === 'untested'  ? '&#9675; Not Tested'
                     : a.status === 'normal'    ? '&#10003; Integrity Normal'
                     :                            '&#9670; Reference Tract';
    // Untested pathways carry no metric/z — scoreStr collapses to empty automatically.
    const zStr     = a.z != null ? ` · z = ${a.z >= 0 ? '+' : ''}${a.z.toFixed(2)}` : '';
    const scoreStr = (a.status !== 'untested' && a.metric)
      ? ` &mdash; ${a.metric}: ${a.value}${a.unit || ''}${zStr}` : '';
    const citHtml  = a.citations.map(c => `<div>${c}</div>`).join('');
    return `
      <div class="dth-tract-card status-${a.status}">
        <div class="dth-tract-name">${a.tractName}</div>
        <div class="dth-test-label">${a.testName}${scoreStr}</div>
        <span class="dth-badge ${a.status}">${badgeLabel}</span>
        <div class="dth-note">${a.note}</div>
        <div class="dth-citation">${citHtml}</div>
      </div>`;
  }).join('');

  // §3 Cognitive footprint radar (Z-scores across cognitive domains)
  renderCognitiveRadar(values);

  // Reset baseline toggle to User Profile
  document.getElementById('btn-user-profile').classList.add('dth-active');
  document.getElementById('btn-healthy-baseline').classList.remove('dth-active');

  // Each twin session opens in the Functional Hologram view
  _setBrainViewMode('hologram');

  // Hide left panel and API cheatsheet for clean twin view
  const panel    = document.getElementById('panel');
  const apiPanel = document.getElementById('api-panel');
  const hint     = document.getElementById('hint');
  panel.style.opacity        = '0';
  panel.style.pointerEvents  = 'none';
  apiPanel.style.opacity     = '0';
  hint.style.opacity         = '0';

  // Show HUD
  document.getElementById('digital-twin-hud').classList.remove('hidden');

  // Auto-start cinematic tour
  _startCinematic(analyses);
}

// ── §3 Z-Score Radar (cognitive footprint) ───────────────────────────────────
// Plots the patient's per-domain Z-scores as a spider chart. Outer = supra-normal,
// centre = deficit; the solid ring is the population norm (z=0), dashed rings are
// ±1.5 SD (the deficit / hyper thresholds). Vertices are coloured by domain status.
// Two palettes: 'dark' (holographic HUD) and 'print' (dark-on-white for the PDF).
const RADAR_THEME = {
  dark: {
    axis: 'rgba(200,224,255,0.82)', spoke: 'rgba(120,160,220,0.16)',
    norm: 'rgba(120,180,255,0.55)', grid: 'rgba(120,160,220,0.16)',
    defZone: 'rgba(255,80,60,0.10)', dataFill: 'rgba(90,210,255,0.16)', dataStroke: '#5ad2ff',
    vtxStroke: '#0a1020', center: 'rgba(160,200,255,0.5)',
    title: 'rgba(140,190,255,0.85)', caption: 'rgba(150,185,235,0.5)',
    deficit: '#ff5a44', hyper: '#c95aff', normal: '#39d0c8',
  },
  print: {
    axis: '#334155', spoke: 'rgba(100,116,139,0.35)',
    norm: '#475569', grid: 'rgba(100,116,139,0.35)',
    defZone: 'rgba(220,50,40,0.08)', dataFill: 'rgba(37,99,235,0.12)', dataStroke: '#2563eb',
    vtxStroke: '#ffffff', center: '#64748b',
    title: '#1e293b', caption: '#64748b',
    deficit: '#dc2626', hyper: '#7c3aed', normal: '#0d9488',
  },
};

function renderCognitiveRadar(values, opts = {}) {
  const P = RADAR_THEME[opts.theme] || RADAR_THEME.dark;
  const el = document.getElementById(opts.targetId || 'dth-radar');
  if (!el) return;
  const profile = (window.brain.computeDomainProfile
    ? window.brain.computeDomainProfile(values) : []).filter(d => d.hasData);

  if (profile.length < 3) {
    el.innerHTML = opts.theme === 'print'
      ? `<div style="font-size:8pt;color:#64748b;padding:14pt 8pt;text-align:center;border:1px dashed #cbd5e1;border-radius:6pt;">Cognitive footprint requires ≥ 3 assessed domains (${profile.length}/3 completed).</div>`
      : `<div class="dth-radar-empty">Complete at least <b>3</b> cognitive domains to plot the Z-score footprint.<br><span style="opacity:.7">${profile.length}/3 domains assessed</span></div>`;
    return;
  }

  const W = 300, H = 250, cx = 150, cy = 116, R = 84, N = profile.length;
  const ang = i => (-90 + i * 360 / N) * Math.PI / 180;
  const rz  = z => ((Math.max(-3, Math.min(3, z)) + 3) / 6) * R;
  const pt  = (i, r) => [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))];
  const ring = r => profile.map((_, i) => pt(i, r).map(n => n.toFixed(1)).join(',')).join(' ');
  const statusColor = s => s === 'deficit' ? P.deficit : s === 'hyper' ? P.hyper : P.normal;

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Z-score cognitive footprint">`;
  svg += `<polygon points="${ring(rz(-1.5))}" fill="${P.defZone}"/>`;
  [-3, -1.5, 0, 1.5, 3].forEach(z => {
    const norm = z === 0;
    svg += `<polygon points="${ring(rz(z))}" fill="none" stroke="${norm ? P.norm : P.grid}" ` +
      `stroke-width="${norm ? 1.2 : 0.8}" ${norm ? '' : 'stroke-dasharray="2 3"'}/>`;
  });
  profile.forEach((d, i) => {
    const [ox, oy] = pt(i, R);
    svg += `<line x1="${cx}" y1="${cy}" x2="${ox.toFixed(1)}" y2="${oy.toFixed(1)}" stroke="${P.spoke}" stroke-width="0.8"/>`;
    const [lx, ly] = pt(i, R + 11);
    const c = Math.cos(ang(i));
    const anchor = c > 0.3 ? 'start' : c < -0.3 ? 'end' : 'middle';
    svg += `<text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" font-size="7.5" font-weight="700" ` +
      `fill="${P.axis}" text-anchor="${anchor}" font-family="Inter,Arial,sans-serif">${d.label}</text>`;
  });
  svg += `<polygon points="${profile.map((d, i) => pt(i, rz(d.zc)).map(n => n.toFixed(1)).join(',')).join(' ')}" ` +
    `fill="${P.dataFill}" stroke="${P.dataStroke}" stroke-width="1.6" stroke-linejoin="round"/>`;
  profile.forEach((d, i) => {
    const [vx, vy] = pt(i, rz(d.zc));
    svg += `<circle cx="${vx.toFixed(1)}" cy="${vy.toFixed(1)}" r="3.1" fill="${statusColor(d.status)}" stroke="${P.vtxStroke}" stroke-width="0.8"/>`;
  });
  svg += `<circle cx="${cx}" cy="${cy}" r="1.5" fill="${P.center}"/>`;
  svg += `<text x="${cx}" y="${H - 22}" font-size="8" font-weight="700" letter-spacing="0.8" fill="${P.title}" text-anchor="middle" font-family="Inter,Arial,sans-serif">COGNITIVE FOOTPRINT · Z-SCORES</text>`;
  svg += `<text x="${cx}" y="${H - 10}" font-size="7" fill="${P.caption}" text-anchor="middle" font-family="Inter,Arial,sans-serif">outer = supra-normal · centre = deficit · solid ring = norm</text>`;
  svg += `</svg>`;
  el.innerHTML = svg;
}
// Exposed for QA and for reuse by the PDF export (embeds the same footprint).
window.renderCognitiveRadar = renderCognitiveRadar;

function _highlightTractCard(tractKey) {
  if (!_lastTwinAnalyses) return;
  const idx = _lastTwinAnalyses.findIndex(a => a.tractKey === tractKey);
  if (idx === -1) return;

  // Don't override cinematic highlight — it owns card state while playing
  if (window.brain.isCinematicPlaying()) return;

  const cards = document.querySelectorAll('.dth-tract-card');
  cards.forEach((card, i) => {
    card.classList.toggle('dth-active-card', i === idx);
    card.classList.toggle('dth-dim-card',    i !== idx);
  });
  if (cards[idx]) {
    cards[idx].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }

  // Auto-clear highlight after 3 s so the user isn't permanently locked into dim mode
  clearTimeout(_tractHighlightTimeout);
  _tractHighlightTimeout = setTimeout(() => {
    document.querySelectorAll('.dth-tract-card').forEach(card => {
      card.classList.remove('dth-active-card', 'dth-dim-card');
    });
    _tractHighlightTimeout = null;
  }, 3000);
}

function _startCinematic(analyses) {
  // Clear any pending raycaster card highlight before the tour takes over card state
  clearTimeout(_tractHighlightTimeout);
  _tractHighlightTimeout = null;
  document.querySelectorAll('.dth-tract-card').forEach(card => {
    card.classList.remove('dth-active-card', 'dth-dim-card');
  });

  const tourBtn = document.getElementById('btn-play-tour');
  tourBtn.textContent = '■ Stop Tour';
  tourBtn.classList.add('tour-active');
  window.brain.playTwinCinematic(analyses, _onTwinStep, _onTwinComplete);
}

function _onTwinStep(stepIndex) {
  playWhoosh();

  document.querySelectorAll('.dth-tract-card').forEach((card, i) => {
    card.classList.toggle('dth-active-card', i === stepIndex);
    card.classList.toggle('dth-dim-card',    i !== stepIndex);
  });
  // Scroll the active card into view within the HUD panel
  const cards = document.querySelectorAll('.dth-tract-card');
  if (cards[stepIndex]) {
    cards[stepIndex].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }

  // Live Insight panel — educational explanation synced to the focused region
  _showClinicalInsight(_lastTwinAnalyses?.[stepIndex]);
}

// ── 'Clinical Insight' educational panel ───────────────────────────────────────
// Explains, for the region the camera is focused on: what it does normally, what
// the test measured, and what the modelled pathophysiology means — with citations.
const STATUS_LABEL = {
  deficit:   'Deficit / Hypo-connectivity',
  hyper:     'Hyper-connectivity',
  normal:    'Integrity Normal',
  reference: 'Reference',
};

function _showClinicalInsight(a) {
  const panel = document.getElementById('clinical-insight');
  if (!panel || !a) return;

  document.getElementById('ci-region').textContent = a.tractName;
  const zStr = a.z != null ? ` · z = ${a.z >= 0 ? '+' : ''}${a.z.toFixed(2)}`
             : (a.value != null ? ` · ${a.value}${a.unit || ''}` : '');
  document.getElementById('ci-test').textContent = a.testName + zStr;

  const badge = document.getElementById('ci-badge');
  badge.textContent = STATUS_LABEL[a.status] ?? a.status;
  badge.className   = `ci-badge ci-${a.status}`;

  const ins = a.insight ?? {};
  document.getElementById('ci-normal').textContent   = ins.normal          ?? '—';
  document.getElementById('ci-measures').textContent = ins.measures        ?? '—';
  document.getElementById('ci-patho').textContent    = ins.pathophysiology ?? a.note ?? '—';
  document.getElementById('ci-cite').textContent     = (a.citations && a.citations[0]) ? a.citations[0] : '';

  panel.classList.remove('hidden');
}

function _hideClinicalInsight() {
  document.getElementById('clinical-insight')?.classList.add('hidden');
}

function _onTwinComplete() {
  _hideClinicalInsight();
  // Remove all active/dim classes from cards
  document.querySelectorAll('.dth-tract-card').forEach(card => {
    card.classList.remove('dth-active-card', 'dth-dim-card');
  });
  const tourBtn = document.getElementById('btn-play-tour');
  if (tourBtn) {
    tourBtn.textContent = '&#9654;  Play Tour';
    tourBtn.innerHTML   = '&#9654;&nbsp; Play Tour';
    tourBtn.classList.remove('tour-active');
  }
}

function exportClinicalReport() {
  // ── 0. Patient profile ────────────────────────────────────────────────────
  populatePrintProfile();

  // ── 1. Brain snapshot ─────────────────────────────────────────────────────
  // composer.render() + toDataURL() called synchronously inside exportBrainSnapshot().
  // preserveDrawingBuffer: true on the renderer backs this up for slow browsers.
  const imgData = window.brain.exportBrainSnapshot();
  document.getElementById('print-brain-img').src = imgData;

  // ── 1b. Cognitive-footprint radar (print-themed, dark-on-white) ───────────
  // Reuses the same domain Z-score engine as the on-screen HUD chart so the
  // report and the live dashboard always agree.
  renderCognitiveRadar(_lastTwinValues || {}, { targetId: 'print-radar', theme: 'print' });

  // ── 2. Clone the SVG timeline (may be empty if no runs) ───────────────────
  const chartSrc   = document.getElementById('chart-container');
  const printTl    = document.getElementById('print-timeline-svg');
  printTl.innerHTML = chartSrc ? chartSrc.innerHTML : '';

  // ── 3. Tract findings + deduplicated citation list ────────────────────────
  const tractEl = document.getElementById('print-tract-findings');
  const citEl   = document.getElementById('print-citations-list');

  if (_lastTwinAnalyses && _lastTwinAnalyses.length > 0) {
    tractEl.innerHTML = _lastTwinAnalyses.map(a => {
      const zStr     = a.z != null ? ` · z = ${a.z >= 0 ? '+' : ''}${a.z.toFixed(2)}` : '';
      const scoreStr = a.metric ? ` &mdash; ${a.metric}: <strong>${a.value}${a.unit || ''}</strong>${zStr}` : '';
      return `
        <div class="pr-tract pr-${a.status}">
          <h3>${a.tractName}
            <span class="pr-status-${a.status}">[${a.status.toUpperCase()}]</span>
          </h3>
          <p><em>${a.testName}${scoreStr}</em></p>
          <p>${a.note}</p>
        </div>`;
    }).join('');

    // Collect all citations in order, deduplicated by text content
    const seen = new Set();
    const allCitations = _lastTwinAnalyses
      .flatMap(a => a.citations)
      .filter(c => { if (seen.has(c)) return false; seen.add(c); return true; });

    citEl.innerHTML = allCitations.map(c => `<li>${c}</li>`).join('');
  } else {
    tractEl.innerHTML = '<p><em>No twin analysis available. Generate the Digital Brain Twin first.</em></p>';
    citEl.innerHTML   = '';
  }

  // ── 4. Datestamp ─────────────────────────────────────────────────────────
  document.getElementById('print-date').textContent = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  // ── 5. Open print dialog ──────────────────────────────────────────────────
  window.print();
}

function exitDigitalTwin() {
  window.brain.stopTwinCinematic();
  _hideClinicalInsight();
  document.getElementById('digital-twin-hud').classList.add('hidden');

  window.brain.clearDigitalTwin();
  window.brain.setCortexCutaway(false);   // seal the cortex back up
  window.brain.restoreSceneLighting();
  window.brain.setSceneBackground(0x0D1424);
  window.brain.setBaselineGhostVisible(true);
  window.brain.setGridVisible(true);
  _setBrainViewMode('hologram');          // leave the scene in the default view

  // Reset the research tools (surgical planning, lesions, 4D projection).
  window.brain.setSurgicalMode?.(false);
  window.brain.clearLesions?.();
  window.brain.setProgression?.(0);
  document.getElementById('btn-surgical-mode')?.classList.remove('active');
  document.getElementById('lesion-tools')?.classList.add('hidden');
  const _lw = document.getElementById('lesion-warnings'); if (_lw) { _lw.innerHTML = ''; _lw.classList.add('hidden'); }
  const _ps = document.getElementById('progress-slider'); if (_ps) { _ps.value = 0; _ps.style.setProperty('--val', '0%'); }
  const _pr = document.getElementById('progress-readout'); if (_pr) _pr.textContent = 'Current Day';
  const _c = document.getElementById('niivue-gl'); if (_c) _c.style.cursor = '';

  _lastTwinAnalyses = null;
  _onTwinComplete(); // reset button/card states

  const panel    = document.getElementById('panel');
  const apiPanel = document.getElementById('api-panel');
  const hint     = document.getElementById('hint');
  panel.style.opacity        = '';
  panel.style.pointerEvents  = '';
  apiPanel.style.opacity     = '';
  hint.style.opacity         = '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLINICAL TIMELINE DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════
function renderDashboard() {
  renderProfileSummary();
  const container = document.getElementById('chart-container');
  const summary   = document.getElementById('clinical-summary');

  if (userTimelineResults.length === 0) {
    container.innerHTML = '<div class="chart-empty">Complete at least one test to see your Clinical Timeline.</div>';
    summary.innerHTML   = '';
    return;
  }

  // Sort chronologically. Guard against any malformed entry (non-finite score)
  // so a single bad record can never break the whole timeline SVG.
  const sorted = [...userTimelineResults]
    .filter(r => Number.isFinite(r.score))
    .sort((a, b) => a.date - b.date);
  const n      = sorted.length;

  if (n === 0) {
    container.innerHTML = '<div class="chart-empty">Complete at least one test to see your Clinical Timeline.</div>';
    summary.innerHTML   = '';
    return;
  }

  // SVG layout
  const VW = 600, VH = 260;
  const PAD = { top: 28, right: 26, bottom: 46, left: 52 };
  const cW  = VW - PAD.left - PAD.right;
  const cH  = VH - PAD.top  - PAD.bottom;

  // Display scores are z-derived: displayScore = clamp(50 + z·20). So 50 = the
  // population NORMATIVE MEAN (z=0), 80 = z+1.5 (supra-normal), 20 = z−1.5 (deficit).
  // The reference line marks the normative mean; the status tiers below use the
  // clinical deficit cut-off, so a normal/correct performance is NEVER flagged.
  const NORM_MEAN   = 50;   // z = 0  (chart reference line)
  const DEFICIT_CUT = 20;   // z = −1.5 (clinical deficit threshold)
  const TEST_COL  = { stroop: '#3B7BF8', nback: '#22C97A', rsvp: '#F87B3B', corsi: '#E0913F', verbalFluency: '#15B8A6', aq10: '#C95AE0', fingerTapping: '#5AB8FF', goNoGo: '#FF6B5A', trailsB: '#8B7BFF' };
  const TEST_ABBR = { stroop: 'Stroop', nback: 'N-Back', rsvp: 'RSVP', corsi: 'Corsi', verbalFluency: 'Fluency', aq10: 'AQ-10', fingerTapping: 'FTT', goNoGo: 'Go/NoGo', trailsB: 'TMT-B' };

  const dates  = sorted.map(r => r.date.getTime());
  const minT   = dates[0];
  const tSpan  = dates[n - 1] - minT;
  // For rapid demo sessions (<5 s apart) spread points evenly by index
  const useTimeX = tSpan >= 5000 && n > 1;

  const xOf = (r, i) => {
    if (!useTimeX || n === 1) return PAD.left + (n === 1 ? cW / 2 : (i / (n - 1)) * cW);
    return PAD.left + ((r.date.getTime() - minT) / tSpan) * cW;
  };
  const yOf = s => PAD.top + (1 - s / 100) * cH;

  const pts = sorted.map((r, i) => ({
    x:     xOf(r, i),
    y:     yOf(r.score),
    score: r.score,
    test:  r.test,
    date:  r.date,
    col:   TEST_COL[r.test]  || '#3B7BF8',
    abbr:  TEST_ABBR[r.test] || (r.test || '?'),
  }));

  const polyline = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const baseY    = yOf(NORM_MEAN).toFixed(1);
  const fmtTime  = d =>
    `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;

  const yTicks = [0, 25, 50, 75, 100];

  container.innerHTML = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${VH}" width="100%"
     style="display:block" aria-label="Clinical Timeline Chart">
  <defs>
    <filter id="glowF" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="3.5" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#3B7BF8"/>
      <stop offset="100%" stop-color="#22C97A"/>
    </linearGradient>
    <clipPath id="chartClip">
      <rect x="${PAD.left}" y="${PAD.top}" width="${cW}" height="${cH}"/>
    </clipPath>
  </defs>

  <!-- Chart area background -->
  <rect x="${PAD.left}" y="${PAD.top}" width="${cW}" height="${cH}"
        rx="8" fill="#F7F9FF" stroke="#E4EEFF" stroke-width="1"/>

  <!-- Y grid + labels -->
  ${yTicks.map(tick => {
    const ty = yOf(tick).toFixed(1);
    const isMajor = tick === 0 || tick === 100;
    return `<line x1="${PAD.left}" y1="${ty}" x2="${PAD.left + cW}" y2="${ty}"
                  stroke="${isMajor ? '#D0DCEE' : '#E8EFFC'}" stroke-width="1"
                  ${isMajor ? '' : 'stroke-dasharray="4,4"'}/>
            <text x="${PAD.left - 7}" y="${(yOf(tick) + 4).toFixed(1)}"
                  text-anchor="end" font-size="10" fill="#A8B8D0"
                  font-family="Inter,sans-serif">${tick}%</text>`;
  }).join('\n  ')}

  <!-- Clinical baseline line -->
  <g clip-path="url(#chartClip)">
    <line x1="${PAD.left}" y1="${baseY}" x2="${PAD.left + cW}" y2="${baseY}"
          stroke="#F59E42" stroke-width="1.5" stroke-dasharray="7,5" opacity="0.80"/>
  </g>
  <text x="${PAD.left + cW - 4}" y="${(yOf(NORM_MEAN) - 5).toFixed(1)}"
        text-anchor="end" font-size="9" fill="#F59E42"
        font-family="Inter,sans-serif" opacity="0.9">Normative Mean (Z = 0)</text>

  <!-- Axes -->
  <line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + cH}"
        stroke="#C8D8F0" stroke-width="1.5"/>
  <line x1="${PAD.left}" y1="${PAD.top + cH}" x2="${PAD.left + cW}" y2="${PAD.top + cH}"
        stroke="#C8D8F0" stroke-width="1.5"/>

  <!-- Y-axis label -->
  <text transform="rotate(-90,13,${(PAD.top + cH / 2).toFixed(1)})"
        x="13" y="${(PAD.top + cH / 2).toFixed(1)}" text-anchor="middle"
        font-size="10" fill="#637087" font-family="Inter,sans-serif">Score %</text>

  ${n > 1 ? `
  <!-- Line: wide soft glow then crisp overlay -->
  <g clip-path="url(#chartClip)">
    <polyline points="${polyline}" fill="none" stroke="url(#lineGrad)"
              stroke-width="8" stroke-linecap="round" stroke-linejoin="round"
              opacity="0.18"/>
    <polyline points="${polyline}" fill="none" stroke="url(#lineGrad)"
              stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
              filter="url(#glowF)"/>
  </g>` : ''}

  <!-- Data points -->
  ${pts.map(p => `
  <g>
    <title>${p.abbr} — ${p.score}% at ${fmtTime(p.date)}</title>
    <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="11" fill="${p.col}" opacity="0.12"/>
    <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5"  fill="${p.col}" stroke="white" stroke-width="2"/>
    <text x="${p.x.toFixed(1)}" y="${(p.y - 13).toFixed(1)}"
          text-anchor="middle" font-size="10" font-weight="600"
          fill="${p.col}" font-family="Inter,sans-serif">${p.score}%</text>
    <text x="${p.x.toFixed(1)}" y="${(PAD.top + cH + 14).toFixed(1)}"
          text-anchor="middle" font-size="8.5" fill="#A8B8D0"
          font-family="Inter,sans-serif">${p.abbr}</text>
    ${useTimeX ? `<text x="${p.x.toFixed(1)}" y="${(PAD.top + cH + 27).toFixed(1)}"
          text-anchor="middle" font-size="8" fill="#C0CCDD"
          font-family="Inter,sans-serif">${fmtTime(p.date)}</text>` : ''}
  </g>`).join('')}
</svg>`;

  // ── Clinical summary (three-tier, z-score based) ────────────────────────────
  // Only a genuine sub-threshold score (≤ deficit cut-off, z ≤ −1.5) is flagged;
  // a normal/correct performance reads "Within Normative Limits", never "atrophy".
  const latest = sorted[n - 1];
  const delta  = n >= 2 ? latest.score - sorted[n - 2].score : null;

  let sClass, sIcon, sText;
  if (latest.score >= 66) {                 // z ≥ +0.8 — comfortably above the mean
    sClass = 'status-positive'; sIcon = '&#9650;'; sText = 'Performance Above Normative Mean';
  } else if (latest.score > DEFICIT_CUT) {  // within normal limits (z between −1.5 and +0.8)
    sClass = 'status-neutral';  sIcon = '&#9679;'; sText = 'Within Normative Limits';
  } else {                                  // z ≤ −1.5 — clinical deficit
    sClass = 'status-negative'; sIcon = '&#9660;'; sText = 'Sub-threshold Performance &mdash; Clinical Follow-up Advised';
  }

  summary.innerHTML = `
    <div class="clinical-status ${sClass}">
      <div class="status-indicator">${sIcon}</div>
      <div class="status-text">
        <div class="status-label">Status</div>
        <div class="status-value">${sText}</div>
        ${delta !== null
          ? `<div class="status-trend">&Delta; ${delta >= 0 ? '+' : ''}${delta}% from previous session</div>`
          : ''}
      </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORSI BLOCK-TAPPING TEST  (Visuospatial / Episodic Span → Hippocampus + Fornix)
//
// The canonical adaptive spatial-span paradigm.  A sequence of blocks flashes;
// the patient reproduces it in order.  Span starts at 3 and escalates by one each
// time a length is passed; two failures at a length end the test.  The highest
// passed length (the Corsi span) maps to the clinical score that drives fornix /
// hippocampal modelling in the Digital Twin — a low span physically atrophies the
// procedural hippocampus meshes inside the cutaway brain.
// ═══════════════════════════════════════════════════════════════════════════════
const CORSI_BLOCKS     = 9;
const CORSI_START_SPAN = 3;
const CORSI_MAX_SPAN   = 8;
const CORSI_FLASH_MS   = 620;   // block lit duration during playback
const CORSI_GAP_MS     = 240;   // gap between flashes

// Fixed clinical layout (stable, non-overlapping) — percentages within the board
const CORSI_LAYOUT = [
  [14, 20], [50, 12], [83, 22],
  [24, 50], [62, 46], [88, 60],
  [12, 80], [45, 86], [76, 84],
];

let corsiSequence       = [];
let corsiInput          = [];
let corsiSpan           = CORSI_START_SPAN;
let corsiDirection      = 'forward'; // 'forward' block, then 'backward' block
let corsiSuccess        = 0;         // successful trials at the current span (need 2)
let corsiFail           = 0;         // failed trials at the current span (2 ends block)
let corsiBestForward    = 0;
let corsiBestBackward   = 0;
let corsiAcceptingInput = false;
let corsiAborted        = false;
let corsiTimeouts       = [];        // all pending setTimeouts, cleared on abort

function _corsiSetPhase(text) {
  const el = document.getElementById('corsi-phase');
  if (el) el.textContent = text;
}

function _corsiFlash(idx, cls, ms) {
  const el = document.querySelector(`.corsi-block[data-idx="${idx}"]`);
  if (!el) return;
  el.classList.add(cls);
  corsiTimeouts.push(setTimeout(() => el.classList.remove(cls), ms));
}

function _corsiRandomSeq(len) {
  const idx = [...Array(CORSI_BLOCKS).keys()];
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, len);
}

function buildCorsiBoard() {
  const board = document.getElementById('corsi-board');
  board.innerHTML = '';
  CORSI_LAYOUT.forEach(([x, y], i) => {
    const b = document.createElement('div');
    b.className     = 'corsi-block';
    b.dataset.idx   = i;
    b.style.left    = `${x}%`;
    b.style.top     = `${y}%`;
    b.addEventListener('click', () => handleCorsiClick(i));
    board.appendChild(b);
  });
}

function startCorsi() {
  corsiAborted        = false;
  corsiAcceptingInput = false;
  corsiTimeouts.forEach(clearTimeout);
  corsiTimeouts       = [];
  corsiDirection      = 'forward';
  corsiSpan           = CORSI_START_SPAN;
  corsiSuccess        = 0;
  corsiFail           = 0;
  corsiBestForward    = 0;
  corsiBestBackward   = 0;
  corsiInput          = [];

  document.getElementById('corsi-best').textContent = '0';
  const accEl = document.getElementById('corsi-acc');
  accEl.textContent = '—';
  accEl.style.color = '';

  buildCorsiBoard();
  showScreen('corsi');

  corsiTimeouts.push(setTimeout(() => { if (!corsiAborted) nextCorsiLevel(); }, 700));
}

function nextCorsiLevel() {
  if (corsiAborted) return;
  corsiInput    = [];
  corsiSequence = _corsiRandomSeq(corsiSpan);
  document.getElementById('corsi-span').textContent  = corsiSpan;
  document.getElementById('corsi-trial').textContent = (corsiSuccess + corsiFail) + 1;
  playbackCorsi();
}

function playbackCorsi() {
  corsiAcceptingInput = false;
  _corsiSetPhase(corsiDirection === 'forward' ? 'Watch · Forward' : 'Watch · Backward');
  document.getElementById('corsi-hint').textContent = 'Memorize the sequence…';
  document.getElementById('corsi-board').classList.remove('recall-mode');

  let t = 500;
  corsiSequence.forEach(blockIdx => {
    corsiTimeouts.push(setTimeout(() => {
      if (corsiAborted) return;
      _corsiFlash(blockIdx, 'corsi-lit', CORSI_FLASH_MS);
      playClick();
    }, t));
    t += CORSI_FLASH_MS + CORSI_GAP_MS;
  });

  corsiTimeouts.push(setTimeout(() => {
    if (!corsiAborted) beginCorsiRecall();
  }, t + 150));
}

function beginCorsiRecall() {
  corsiAcceptingInput = true;
  _corsiSetPhase(corsiDirection === 'forward' ? 'Recall · Forward' : 'Recall · Backward');
  document.getElementById('corsi-hint').textContent = corsiDirection === 'forward'
    ? `Reproduce the sequence IN ORDER — ${corsiSpan} blocks`
    : `Reproduce the sequence IN REVERSE — ${corsiSpan} blocks`;
  document.getElementById('corsi-board').classList.add('recall-mode');
}

function handleCorsiClick(idx) {
  if (!corsiAcceptingInput || corsiAborted) return;
  playClick();

  const step = corsiInput.length;
  // Backward block expects the reversed sequence.
  const expected = corsiDirection === 'forward'
    ? corsiSequence[step]
    : corsiSequence[corsiSequence.length - 1 - step];

  if (idx === expected) {
    corsiInput.push(idx);
    _corsiFlash(idx, 'corsi-tap', 260);
    if (corsiInput.length === corsiSequence.length) {
      corsiAcceptingInput = false;
      corsiTimeouts.push(setTimeout(() => corsiLevelResult(true), 320));
    }
  } else {
    corsiAcceptingInput = false;
    _corsiFlash(idx, 'corsi-wrong', 440);
    corsiTimeouts.push(setTimeout(() => corsiLevelResult(false), 500));
  }
}

// Standard clinical pacing: TWO successful trials advance the span; two failures
// end the current direction (forward, then backward).
function corsiLevelResult(success) {
  if (corsiAborted) return;
  const accEl = document.getElementById('corsi-acc');

  if (success) {
    corsiSuccess++;
    accEl.textContent = '✓';
    accEl.style.color = '#22C97A';

    if (corsiSuccess >= 2) {
      if (corsiDirection === 'forward') corsiBestForward  = Math.max(corsiBestForward,  corsiSpan);
      else                              corsiBestBackward = Math.max(corsiBestBackward, corsiSpan);
      document.getElementById('corsi-best').textContent =
        corsiDirection === 'forward' ? corsiBestForward : corsiBestBackward;

      corsiSpan++; corsiSuccess = 0; corsiFail = 0;
      if (corsiSpan > CORSI_MAX_SPAN) { endCorsiDirection(); return; }
      document.getElementById('corsi-hint').textContent = 'Two passed — advancing to a longer span…';
      corsiTimeouts.push(setTimeout(() => { if (!corsiAborted) nextCorsiLevel(); }, 950));
    } else {
      document.getElementById('corsi-hint').textContent = 'Correct — one more at this length to advance';
      corsiTimeouts.push(setTimeout(() => { if (!corsiAborted) nextCorsiLevel(); }, 950));
    }
  } else {
    corsiFail++;
    accEl.textContent = '✗';
    accEl.style.color = '#E84848';
    if (corsiFail >= 2) { endCorsiDirection(); return; }
    document.getElementById('corsi-hint').textContent = 'Missed — one more attempt at this length';
    corsiTimeouts.push(setTimeout(() => { if (!corsiAborted) nextCorsiLevel(); }, 1150));
  }
}

function endCorsiDirection() {
  if (corsiAborted) return;
  if (corsiDirection === 'forward') {
    corsiDirection = 'backward';
    corsiSpan      = CORSI_START_SPAN;
    corsiSuccess   = 0;
    corsiFail      = 0;
    document.getElementById('corsi-best').textContent = corsiBestBackward;
    document.getElementById('corsi-hint').textContent = 'Forward span complete — now reproduce sequences in REVERSE.';
    corsiTimeouts.push(setTimeout(() => { if (!corsiAborted) nextCorsiLevel(); }, 1600));
  } else {
    finishCorsi();
  }
}

function finishCorsi() {
  if (corsiAborted) return;
  corsiAcceptingInput = false;

  const fwd = corsiBestForward;
  const bwd = corsiBestBackward;
  // Clinical metric: mean of forward and backward spans (blocks).
  const value = Math.round(((fwd + bwd) / 2) * 10) / 10;

  window.brain.setRegionBrightness('nBackGame', value >= NORMATIVE.corsi.mean ? 1.8 : 0.3);
  if (value >= NORMATIVE.corsi.mean) {
    window.brain.triggerNeuroplasticity('leftHippocampus',  1.10, 1300);
    window.brain.triggerNeuroplasticity('rightHippocampus', 1.10, 1300);
  }

  const resultMsg = `Forward span ${fwd} · Backward span ${bwd} · combined ${value} blocks (norm ${NORMATIVE.corsi.mean}).`;
  const brainMsg = value >= NORMATIVE.corsi.mean
    ? 'Robust visuospatial span across forward and backward recall — the hippocampal–fornix circuit encoded and manipulated the spatial sequences efficiently.'
    : 'Reduced visuospatial span indicates strain on hippocampal sequence encoding and manipulation. The Digital Twin models fornix and hippocampal FA variance.';

  finalizeClinical(value, { resultMsg, brainMsg });
}

// ═══════════════════════════════════════════════════════════════════════════════
// VERBAL FLUENCY TEST  (FAS / Semantic → Frontal Aslant Tract / Broca's Area)
//
// 60-second timed word generation.  Phonemic mode (letter F/A/S) or semantic mode
// (category "Animals").  Valid words must match the prompt, be ≥ 2 letters, and be
// non-repeats (perseverations are rejected, as in the clinical scoring).  The count
// maps to a score driving frontal-aslant-tract modelling in the Digital Twin.
// ═══════════════════════════════════════════════════════════════════════════════
const FLUENCY_BLOCK_MS = 60000;
const FLUENCY_LETTERS  = ['F', 'A', 'S'];

let fluencyActive     = false;
let fluencyBlockIndex = 0;
let fluencyLetter     = 'F';
let fluencyWords      = new Set();   // valid words in the CURRENT block
let fluencyTotals     = [];          // word count per completed block
let fluencyTimer      = null;
let fluencyEndAt      = 0;

const fluencyInput = document.getElementById('fluency-input');

function startFluency() {
  fluencyActive     = true;
  fluencyBlockIndex = 0;
  fluencyTotals     = [];
  showScreen('fluency');
  _startFluencyBlock();
}

function _startFluencyBlock() {
  fluencyLetter = FLUENCY_LETTERS[fluencyBlockIndex];
  fluencyWords  = new Set();

  document.getElementById('fluency-prompt').textContent = `“${fluencyLetter}”`;
  document.getElementById('fluency-mode').textContent =
    `Block ${fluencyBlockIndex + 1} / 3 — words starting with “${fluencyLetter}”, press Enter`;
  document.getElementById('fluency-count').textContent = '0';
  document.getElementById('fluency-words').innerHTML   = '';
  document.getElementById('fluency-timer').textContent = '60.0';
  document.getElementById('fluency-bar').style.width   = '100%';
  fluencyInput.value    = '';
  fluencyInput.disabled = false;
  setTimeout(() => fluencyInput.focus(), 60);

  fluencyEndAt = performance.now() + FLUENCY_BLOCK_MS;
  clearInterval(fluencyTimer);
  fluencyTimer = setInterval(_fluencyTick, 80);
}

function _fluencyTick() {
  if (!fluencyActive) return;
  const remain = Math.max(0, fluencyEndAt - performance.now());
  document.getElementById('fluency-timer').textContent = (remain / 1000).toFixed(1);
  document.getElementById('fluency-bar').style.width   = `${(remain / FLUENCY_BLOCK_MS) * 100}%`;
  if (remain <= 0) _endFluencyBlock();
}

function _endFluencyBlock() {
  clearInterval(fluencyTimer); fluencyTimer = null;
  fluencyTotals.push(fluencyWords.size);
  fluencyBlockIndex++;

  if (fluencyBlockIndex < FLUENCY_LETTERS.length) {
    fluencyInput.disabled = true;
    document.getElementById('fluency-mode').textContent =
      `Block done (${fluencyWords.size} words) — next letter in 2 s…`;
    setTimeout(() => { if (fluencyActive) _startFluencyBlock(); }, 2000);
  } else {
    finishFluency();
  }
}

function _fluencyValid(raw) {
  const w = raw.trim().toLowerCase();
  if (w.length < 2) return false;
  if (!/^[a-z][a-z'-]*$/.test(w)) return false;            // letters (+ ' and -) only
  if (w[0] !== fluencyLetter.toLowerCase()) return false;  // must start with the block letter
  if (fluencyWords.has(w)) return false;                    // reject perseverations
  return true;
}

fluencyInput?.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !fluencyActive || fluencyInput.disabled) return;
  e.preventDefault();
  const raw = fluencyInput.value;
  fluencyInput.value = '';

  if (_fluencyValid(raw)) {
    const w = raw.trim().toLowerCase();
    fluencyWords.add(w);
    playClick();
    const chip = document.createElement('span');
    chip.className   = 'fluency-chip';
    chip.textContent = w;
    document.getElementById('fluency-words').prepend(chip);
    document.getElementById('fluency-count').textContent = fluencyWords.size;
    window.brain.setRegionBrightness('fluencyGame', 1.8);
  } else {
    fluencyInput.classList.remove('shake');
    void fluencyInput.offsetWidth;
    fluencyInput.classList.add('shake');
  }
});

function finishFluency() {
  if (!fluencyActive) return;
  fluencyActive = false;
  clearInterval(fluencyTimer); fluencyTimer = null;
  fluencyInput.disabled = true;

  const total = fluencyTotals.reduce((s, n) => s + n, 0);   // FAS total — the clinical metric
  window.brain.setRegionBrightness('fluencyGame', total >= NORMATIVE.verbalFluency.mean ? 1.8 : 0.3);

  const resultMsg =
    `F:${fluencyTotals[0] ?? 0} · A:${fluencyTotals[1] ?? 0} · S:${fluencyTotals[2] ?? 0} → FAS total ${total} (norm ${NORMATIVE.verbalFluency.mean}).`;
  const brainMsg = total >= NORMATIVE.verbalFluency.mean
    ? "Efficient lexical retrieval across all three letters. Broca's area and the frontal aslant tract sustained strategic word search with minimal effort."
    : 'Reduced FAS output suggests effortful Broca-driven retrieval. The Digital Twin models frontal aslant tract FA variance.';

  // FAS total (words) is the verbal-fluency clinical metric → normative Z-engine.
  finalizeClinical(total, { resultMsg, brainMsg });
}

// ═══════════════════════════════════════════════════════════════════════════════
// RAADS-R SENSORY/SOCIAL SCREEN  (proxy → Autism-Spectrum pathophysiology profile)
//
// A short 5-item Likert screen indexing sensory gating + social processing.  Higher
// scores = more autistic-spectrum traits, driving the dual connectivity signature in
// the Digital Twin: long-range Uncinate hypo-connectivity + local frontal hyper-
// connectivity.  This is a screening PROXY, never a diagnosis.
// ═══════════════════════════════════════════════════════════════════════════════
// Official Adult AQ-10 items (Allison, Auyeung & Baron-Cohen, 2012). One point per
// item answered in the autism direction; agree-scored items vs disagree-scored items
// per the published rubric. Total ≥ 6 → NICE-recommended referral threshold.
const AQ10_ITEMS = [
  { q: 'I often notice small sounds when others do not.',                                                  agree: true  },
  { q: 'I usually concentrate more on the whole picture, rather than the small details.',                  agree: false },
  { q: 'I find it easy to do more than one thing at once.',                                                 agree: false },
  { q: 'If there is an interruption, I can switch back to what I was doing very quickly.',                  agree: false },
  { q: 'I find it easy to “read between the lines” when someone is talking to me.',                         agree: false },
  { q: 'I know how to tell if someone listening to me is getting bored.',                                   agree: false },
  { q: 'When I’m reading a story, I find it difficult to work out the characters’ intentions.',             agree: true  },
  { q: 'I like to collect information about categories of things (e.g. types of car, bird, train, plant).', agree: true  },
  { q: 'I find it easy to work out what someone is thinking or feeling just by looking at their face.',     agree: false },
  { q: 'I find it difficult to work out people’s intentions.',                                              agree: true  },
];
const AQ10_ANCHORS = ['Definitely Agree', 'Slightly Agree', 'Slightly Disagree', 'Definitely Disagree'];

let aq10Active = false;
let aq10Index  = 0;
let aq10Sum    = 0;

function startAq10() {
  aq10Active = true;
  aq10Index  = 0;
  aq10Sum    = 0;
  showScreen('aq10');
  _renderAq10Question();
}

function _renderAq10Question() {
  document.getElementById('aq10-progress').textContent = `Question ${aq10Index + 1} / ${AQ10_ITEMS.length}`;
  document.getElementById('aq10-bar').style.width      = `${(aq10Index / AQ10_ITEMS.length) * 100}%`;
  document.getElementById('aq10-question').textContent = AQ10_ITEMS[aq10Index].q;
  document.getElementById('aq10-options').innerHTML =
    AQ10_ANCHORS.map((label, i) => `<button class="raadsr-opt" data-choice="${i}">${label}</button>`).join('');
}

document.getElementById('aq10-options')?.addEventListener('click', e => {
  const btn = e.target.closest('.raadsr-opt');
  if (!btn || !aq10Active) return;
  playClick();
  const choice  = parseInt(btn.dataset.choice, 10);   // 0,1 = agree · 2,3 = disagree
  const isAgree = choice <= 1;
  const item    = AQ10_ITEMS[aq10Index];
  if ((item.agree && isAgree) || (!item.agree && !isAgree)) aq10Sum++;   // official keying

  aq10Index++;
  if (aq10Index >= AQ10_ITEMS.length) finishAq10();
  else _renderAq10Question();
});

function finishAq10() {
  aq10Active = false;
  const value    = aq10Sum;         // 0–10 AQ-10 total — the clinical metric
  const positive = value >= 6;

  window.brain.setRegionBrightness('aq10Game', positive ? 1.8 : 0.3);

  const resultMsg = `AQ-10 total ${value} / 10 (NICE referral threshold ≥ 6). Screening tool — not a diagnosis.`;
  const brainMsg = positive
    ? 'AQ-10 screen-positive. The Digital Twin models the autism connectivity signature: reduced long-range Uncinate FA (amygdala ↔ vmPFC) paired with local frontal hyper-connectivity.'
    : 'AQ-10 below the referral threshold. Amygdala–vmPFC integration and frontal local connectivity are modelled as balanced.';

  finalizeClinical(value, { resultMsg, brainMsg });
}

// ═══════════════════════════════════════════════════════════════════════════════
// FINGER TAPPING TEST  (Motor Speed → Corticospinal Tract & SMA)
//
// Standard clinical FTT protocol: tap the Spacebar as fast as possible for 10 s.
// Measures raw upper-motor-neuron speed and screens for bradykinesia.
// OS keyboard auto-repeat is blocked via a keyup-gated lock (spaceReleased), so
// only genuine physical taps count. The 10-second countdown starts on the first
// tap, driven by a requestAnimationFrame loop against performance.now() for
// sub-16 ms timing accuracy.
// ═══════════════════════════════════════════════════════════════════════════════
let fttTaps       = 0;
let fttActive     = false;    // true only during the 10 s countdown window
let fttAborted    = false;
let spaceReleased = true;     // OS auto-repeat gate: cleared on keydown, armed on keyup
let fttAnimFrame  = null;     // rAF handle — cancelled on abort to stop the loop
let fttStartTime  = 0;        // performance.now() of the first tap

function startFTT() {
  fttTaps       = 0;
  fttActive     = false;
  fttAborted    = false;
  spaceReleased = true;
  fttStartTime  = 0;
  if (fttAnimFrame) { cancelAnimationFrame(fttAnimFrame); fttAnimFrame = null; }

  document.getElementById('ftt-counter').textContent   = '0';
  document.getElementById('ftt-counter').classList.remove('tapping');
  document.getElementById('ftt-timer').textContent     = '10.0';
  document.getElementById('ftt-bar').style.width       = '100%';
  document.getElementById('ftt-phase').textContent     = 'Ready';
  document.getElementById('ftt-instructions').style.opacity = '1';

  showScreen('ftt');
}

function _fttTick() {
  if (!fttActive || fttAborted) return;

  const remaining = Math.max(0, 10000 - (performance.now() - fttStartTime));
  document.getElementById('ftt-timer').textContent = (remaining / 1000).toFixed(1);
  document.getElementById('ftt-bar').style.width   = `${(remaining / 10000) * 100}%`;

  if (remaining <= 0) {
    fttActive = false;
    document.getElementById('ftt-timer').textContent = '0.0';
    document.getElementById('ftt-bar').style.width   = '0%';
    document.getElementById('ftt-phase').textContent = 'Done';
    document.getElementById('ftt-counter').classList.remove('tapping');
    window.brain.setRegionBrightness('fingerTappingGame', fttTaps >= NORMATIVE.fingerTapping.mean ? 1.8 : 0.3);

    const resultMsg = `${fttTaps} taps in 10 s (norm ${NORMATIVE.fingerTapping.mean}±${NORMATIVE.fingerTapping.sd} taps).`;
    const brainMsg  = fttTaps >= NORMATIVE.fingerTapping.mean
      ? 'Tapping rate within or above the normative range — corticospinal tract transmission speed and SMA motor planning modelled as intact.'
      : 'Reduced tapping rate indicates slowed upper-motor-neuron output. The Digital Twin models corticospinal tract FA variance and SMA engagement.';

    setTimeout(() => { if (!fttAborted) finalizeClinical(fttTaps, { resultMsg, brainMsg }); }, 350);
    return;
  }

  fttAnimFrame = requestAnimationFrame(_fttTick);
}

// ── Spacebar handler ──────────────────────────────────────────────────────────
// keydown: count a tap (OS auto-repeat blocked by spaceReleased gate).
// keyup:   re-arm the gate so the next genuine press registers.
window.addEventListener('keydown', e => {
  if (e.code !== 'Space' || currentTest !== 'fingerTapping') return;
  e.preventDefault();                          // prevent page scroll while tapping
  if (fttAborted || !spaceReleased) return;    // block OS auto-repeat
  spaceReleased = false;

  if (!fttActive && fttStartTime === 0) {
    // First press — arm the 10 s countdown
    fttActive    = true;
    fttStartTime = performance.now();
    document.getElementById('ftt-phase').textContent          = 'TAPPING';
    document.getElementById('ftt-instructions').style.opacity = '0';
    document.getElementById('ftt-counter').classList.add('tapping');
    fttAnimFrame = requestAnimationFrame(_fttTick);
  }

  if (!fttActive) return;   // countdown already finished — ignore late presses

  fttTaps++;
  playClick();
  document.getElementById('ftt-counter').textContent = fttTaps;
});

window.addEventListener('keyup', e => {
  if (e.code === 'Space') spaceReleased = true;
});

// ═══════════════════════════════════════════════════════════════════════════════
// GO / NO-GO — Response Inhibition  (maps to goNoGo → right IFG→pre-SMA stopping net)
// A prepotent Go response is built with ~72% Go trials; commission errors on the
// rarer No-Go ("STOP") trials index failure of the inhibitory brake. The RAW metric
// sent to the Z-engine is the commission-error rate (% of No-Go trials responded to).
// ═══════════════════════════════════════════════════════════════════════════════
const GNG_TOTAL    = 36;
const GNG_NOGO_RATE = 0.28;
const GNG_STIM_MS  = 850;    // stimulus visible window
const GNG_ISI_MS   = 420;    // blank inter-stimulus interval

let gngTrials = [], gngIndex = 0, gngActive = false, gngAborted = false;
let gngHits = 0, gngCommissions = 0, gngOmissions = 0, gngGoCount = 0, gngNoGoCount = 0;
let gngRTs = [], gngStimOnset = 0, gngResponded = false, gngTimeouts = [];

function startGoNoGo() {
  gngAborted = false; gngActive = true;
  gngIndex = 0; gngHits = 0; gngCommissions = 0; gngOmissions = 0; gngRTs = [];
  gngTimeouts.forEach(clearTimeout); gngTimeouts = [];

  // Build a shuffled trial list (~28% No-Go).
  const nNoGo = Math.round(GNG_TOTAL * GNG_NOGO_RATE);
  gngTrials = Array.from({ length: GNG_TOTAL }, (_, i) => (i < nNoGo ? 'nogo' : 'go'));
  for (let i = gngTrials.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [gngTrials[i], gngTrials[j]] = [gngTrials[j], gngTrials[i]]; }
  gngGoCount   = gngTrials.filter(t => t === 'go').length;
  gngNoGoCount = gngTrials.filter(t => t === 'nogo').length;

  document.getElementById('gng-hits').textContent = '0';
  document.getElementById('gng-comm').textContent = '0';
  document.getElementById('gng-rt').textContent   = '—';
  document.getElementById('gng-progress').textContent = `0 / ${GNG_TOTAL}`;
  document.getElementById('gng-feedback').innerHTML = '&nbsp;';
  const stim = document.getElementById('gng-stim');
  stim.className = 'gng-stim idle'; stim.textContent = '';

  showScreen('gonogo');
  gngTimeouts.push(setTimeout(_gngNextTrial, 750));
}

function _gngNextTrial() {
  if (gngAborted) return;
  if (gngIndex >= gngTrials.length) { _finishGoNoGo(); return; }
  const kind = gngTrials[gngIndex];
  gngResponded = false;
  const stim = document.getElementById('gng-stim');
  stim.className = 'gng-stim ' + (kind === 'go' ? 'go' : 'nogo');
  stim.textContent = kind === 'go' ? 'GO' : 'STOP';
  gngStimOnset = performance.now();
  document.getElementById('gng-progress').textContent = `${gngIndex + 1} / ${GNG_TOTAL}`;

  gngTimeouts.push(setTimeout(() => {
    if (gngAborted) return;
    if (kind === 'go' && !gngResponded)  { gngOmissions++; _gngFlash('Missed the Go', '#fbbf24'); }
    if (kind === 'nogo' && !gngResponded) { _gngFlash('✓ Correct withhold', '#34d399'); }
    stim.className = 'gng-stim idle'; stim.textContent = '';
    gngIndex++;
    gngTimeouts.push(setTimeout(_gngNextTrial, GNG_ISI_MS));
  }, GNG_STIM_MS));
}

function _gngRespond() {
  if (!gngActive || gngAborted || gngResponded) return;
  const stim = document.getElementById('gng-stim');
  if (!stim.classList.contains('go') && !stim.classList.contains('nogo')) return;  // ISI blank
  gngResponded = true;
  const kind = gngTrials[gngIndex];
  const rt = performance.now() - gngStimOnset;

  if (kind === 'go') {
    gngHits++; gngRTs.push(rt);
    document.getElementById('gng-hits').textContent = gngHits;
    document.getElementById('gng-rt').textContent = Math.round(gngRTs.reduce((a, b) => a + b, 0) / gngRTs.length);
    _gngFlash('✓', '#34d399');
    stim.classList.add('hit');
    playClick();
  } else {
    gngCommissions++;
    document.getElementById('gng-comm').textContent = gngCommissions;
    _gngFlash('✗ Should have withheld!', '#ff6b5a');
    stim.classList.add('err');
  }
}

function _gngFlash(msg, col) {
  const el = document.getElementById('gng-feedback');
  el.textContent = msg; el.style.color = col;
}

function _finishGoNoGo() {
  gngActive = false;
  const commRate = gngNoGoCount ? (gngCommissions / gngNoGoCount) * 100 : 0;
  const avgRT    = gngRTs.length ? Math.round(gngRTs.reduce((a, b) => a + b, 0) / gngRTs.length) : 0;
  // Live brain feedback: tight inhibition brightens the stopping network.
  window.brain.setRegionBrightness('goNoGoGame', commRate <= NORMATIVE.goNoGo.mean ? 1.8 : 0.3);

  const resultMsg = `${gngCommissions}/${gngNoGoCount} No-Go commissions (${commRate.toFixed(0)}%) · ${gngHits}/${gngGoCount} Go hits · avg RT ${avgRT} ms.`;
  const brainMsg  = commRate <= NORMATIVE.goNoGo.mean
    ? 'Commission-error rate within the normative range — the right IFG → pre-SMA stopping network is modelled as intact.'
    : 'Elevated commission errors indicate reduced response inhibition. The Digital Twin models reduced right IFG → pre-SMA connectivity (frontal disinhibition signature).';

  // Effort validity: only flag disengagement — responding to < 50% of Go trials
  // means the patient stopped playing. A LOW commission rate = good inhibition and
  // must never be flagged.
  const goHitRate = gngGoCount ? gngHits / gngGoCount : 0;
  const lowEffort = goHitRate < 0.5;

  setTimeout(() => { if (!gngAborted) finalizeClinical(parseFloat(commRate.toFixed(1)), { resultMsg, brainMsg, lowEffort }); }, 450);
}

// Respond via click on the stimulus, or SPACE.
document.getElementById('gng-stim')?.addEventListener('click', _gngRespond);
window.addEventListener('keydown', e => {
  if (e.code !== 'Space' || currentTest !== 'goNoGo') return;
  e.preventDefault();
  _gngRespond();
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRAIL MAKING TEST — Part B  (maps to trailsB → frontoparietal set-shifting)
// Connect an alternating number–letter trail (1→A→2→B→…) as fast as possible. The
// RAW metric sent to the Z-engine is the completion time in seconds; errors (wrong
// clicks) are tracked separately as a secondary index.
// ═══════════════════════════════════════════════════════════════════════════════
const TMT_PAIRS = 6;   // 1..6 + A..F → 12 nodes

let tmtSeq = [], tmtNodes = [], tmtNext = 0, tmtErrors = 0;
let tmtActive = false, tmtAborted = false, tmtStartTime = 0, tmtTimerRAF = null;

function _tmtBuildSequence() {
  const seq = [];
  for (let i = 1; i <= TMT_PAIRS; i++) { seq.push(String(i)); seq.push(String.fromCharCode(64 + i)); }
  return seq;   // ['1','A','2','B',...,'6','F']
}

function _tmtPlaceNodes() {
  const board = document.getElementById('tmt-board');
  const W = board.clientWidth || 236, H = board.clientHeight || 300;
  const cols = 3, rows = 4, pad = 22;
  const cellW = (W - pad * 2) / cols, cellH = (H - pad * 2) / rows;
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([c, r]);
  for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }

  tmtNodes = tmtSeq.map((label, idx) => {
    const [c, r] = cells[idx];
    const jx = (Math.random() - 0.5) * Math.max(0, cellW - 40);
    const jy = (Math.random() - 0.5) * Math.max(0, cellH - 40);
    return { label, idx, done: false, x: pad + c * cellW + cellW / 2 + jx, y: pad + r * cellH + cellH / 2 + jy };
  });
}

function _tmtRender() {
  const svg = document.getElementById('tmt-lines');
  const nodesEl = document.getElementById('tmt-nodes');
  nodesEl.innerHTML = tmtNodes.map(nd => {
    const cls = nd.done ? ' done' : (tmtSeq[tmtNext] === nd.label ? ' target' : '');
    return `<button class="tmt-node${cls}" data-idx="${nd.idx}" style="left:${(nd.x - 17).toFixed(1)}px;top:${(nd.y - 17).toFixed(1)}px">${nd.label}</button>`;
  }).join('');
  // Completed trail polyline (through the nodes already connected, in order).
  const pathPts = tmtSeq.slice(0, tmtNext).map(lbl => {
    const nd = tmtNodes.find(n => n.label === lbl);
    return `${nd.x.toFixed(1)},${nd.y.toFixed(1)}`;
  }).join(' ');
  svg.innerHTML = pathPts
    ? `<polyline points="${pathPts}" fill="none" stroke="#5ad2ff" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>`
    : '';
}

function startTrails() {
  tmtAborted = false; tmtActive = true; tmtNext = 0; tmtErrors = 0; tmtStartTime = 0;
  if (tmtTimerRAF) { cancelAnimationFrame(tmtTimerRAF); tmtTimerRAF = null; }
  tmtSeq = _tmtBuildSequence();

  document.getElementById('tmt-timer').textContent  = '0.0';
  document.getElementById('tmt-errors').textContent = '0';
  document.getElementById('tmt-next').textContent   = tmtSeq[0];

  showScreen('trails');
  // Wait one frame so the board has real dimensions before placing nodes.
  requestAnimationFrame(() => { if (tmtAborted) return; _tmtPlaceNodes(); _tmtRender(); });
}

function _tmtTick() {
  if (!tmtActive || tmtAborted || tmtStartTime === 0) return;
  document.getElementById('tmt-timer').textContent = ((performance.now() - tmtStartTime) / 1000).toFixed(1);
  tmtTimerRAF = requestAnimationFrame(_tmtTick);
}

function _tmtClick(e) {
  const btn = e.target.closest('.tmt-node');
  if (!btn || !tmtActive || tmtAborted) return;
  const nd = tmtNodes[+btn.dataset.idx];
  if (!nd || nd.done) return;

  if (tmtStartTime === 0) { tmtStartTime = performance.now(); _tmtTick(); }   // start clock on first tap

  if (nd.label === tmtSeq[tmtNext]) {
    nd.done = true; tmtNext++;
    playClick();
    document.getElementById('tmt-next').textContent = tmtNext < tmtSeq.length ? tmtSeq[tmtNext] : '✓';
    _tmtRender();
    if (tmtNext >= tmtSeq.length) _finishTrails();
  } else {
    tmtErrors++;
    document.getElementById('tmt-errors').textContent = tmtErrors;
    btn.classList.add('wrong');
    setTimeout(() => btn.classList.remove('wrong'), 320);
  }
}

function _finishTrails() {
  tmtActive = false;
  if (tmtTimerRAF) { cancelAnimationFrame(tmtTimerRAF); tmtTimerRAF = null; }
  const secs = (performance.now() - tmtStartTime) / 1000;
  window.brain.setRegionBrightness('trailsGame', secs <= NORMATIVE.trailsB.mean ? 1.8 : 0.3);

  const resultMsg = `Completed the ${tmtSeq.length}-node number–letter trail in ${secs.toFixed(1)} s with ${tmtErrors} error${tmtErrors === 1 ? '' : 's'}.`;
  const brainMsg  = secs <= NORMATIVE.trailsB.mean
    ? 'Completion time within the normative range — the frontoparietal set-shifting network is modelled as intact.'
    : 'Prolonged set-shifting time indicates reduced cognitive flexibility. The Digital Twin models reduced frontoparietal (dlPFC ↔ PPC) connectivity.';

  // Effort validity: only flag extreme inactivity/disengagement (> 4 min on a
  // 12-node trail). A merely slow-but-genuine completion is a real clinical
  // finding and must not be flagged.
  const lowEffort = secs > 240;

  setTimeout(() => { if (!tmtAborted) finalizeClinical(parseFloat(secs.toFixed(1)), { resultMsg, brainMsg, lowEffort }); }, 550);
}

document.getElementById('tmt-nodes')?.addEventListener('click', _tmtClick);
