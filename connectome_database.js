// connectome_database.js
// Research-Grade Clinical Battery — Normative Z-Score Engine.
//
// Each cognitive test yields a RAW clinical metric. This module converts that raw
// value into a normative Z-score against peer-reviewed Mean/SD values and maps the
// result to exact AAL (Automated Anatomical Labeling) integer codes for atlas rendering.
//
//   z   = (value − mean) / sd                      ← raw normative deviation
//   zc  = higherIsBetter ? z : −z                  ← sign so NEGATIVE = impaired
//   status: zc ≤ −1.5 → 'deficit'  (hypo-connectivity, red glow)
//           zc ≥ +1.5 → 'hyper'    (supra-normal connectivity, violet glow)
//           else       → 'normal'
//
// AQ-10 is a fixed-cut-off screener (NICE): score ≥ 6 → 'atypical'.
//
// Each tract carries an aalRegions array of exact AAL label integers (voxel values
// in the AAL parcellation). app.js's drawDigitalTwin() reads these to drive the
// atlas colormap: deficit regions glow GLOW_DEFICIT (red), hyper regions glow
// GLOW_HYPER (violet). Where aalRegions is present it takes precedence over the
// legacy from/to REGION_TO_AAL lookup.
//
// Normative sources:
//   stroop        — van Boxtel et al. (2001), "Stroop interference in 1,700 adults";
//                   Scarpina & Tagini (2017), Frontiers in Psychology, 8:557
//   corsi         — Kessels et al. (2000), Applied Neuropsychology 7(4): 252–258
//   verbalFluency — Tombaugh et al. (1999), Archives of Clinical Neuropsychology
//                   14(2): 167–177 (mixed sex, 16–79 yrs, FAS phonemic)
//   rsvp          — internal prototype calibration (synthetic; no published norm)
//   nback         — internal prototype calibration (synthetic; no published norm)
//   aq10          — Allison, Auyeung & Baron-Cohen (2012), JAACAP 51(2): 202–212
//   fingerTapping — Ruff & Parker (1993), Archives of Clinical Neuropsychology
//                   8(4): 359–382 (dominant-hand, 10-second trial)

// ─── Peer-Reviewed Normative Reference Data ───────────────────────────────────
export const NORMATIVE = {
  rsvp:          { metric: 'Reading comprehension index', unit: '%',      mean: 70,   sd: 16,   higherIsBetter: true  },
  nback:         { metric: "d′ (signal detection, 2-back)", unit: '',    mean: 2.06, sd: 0.68, higherIsBetter: true  },
  stroop:        { metric: 'Stroop interference (RT delta)', unit: 'ms', mean: 82.6, sd: 48.0, higherIsBetter: false },
  corsi:         { metric: 'Corsi span (fwd+bwd mean)',   unit: ' blocks', mean: 6.0, sd: 1.1, higherIsBetter: true  },
  verbalFluency: { metric: 'FAS total (F+A+S)',           unit: ' words', mean: 42.5, sd: 11.2, higherIsBetter: true },
  aq10:          { metric: 'AQ-10 score',                 unit: '/10',   cutoff: 6,  higherIsBetter: false            },
  fingerTapping: { metric: 'Taps per 10 s',              unit: ' taps', mean: 55,   sd: 8,    higherIsBetter: true  },
  // ── TBI / neurosurgical-triage additions ──────────────────────────────────────
  goNoGo:        { metric: 'Commission-error rate (No-Go)', unit: '%',  mean: 12,   sd: 7,    higherIsBetter: false },
  trailsB:       { metric: 'TMT-B completion time',        unit: ' s',  mean: 75,   sd: 30,   higherIsBetter: false },
};

/**
 * Classify a raw clinical value against the normative reference.
 * Strict thresholds — zc ≤ −1.5 = deficit, zc ≥ +1.5 = hyper, else normal.
 * @returns {{ z:number|null, zc:number|null, status:'deficit'|'hyper'|'atypical'|'normal' }}
 */
export function classify(testKey, value) {
  const n = NORMATIVE[testKey];
  if (!n || value == null || Number.isNaN(value)) return { z: null, zc: null, status: 'normal' };

  if (n.cutoff != null) {
    const atypical = n.higherIsBetter ? value < n.cutoff : value >= n.cutoff;
    return { z: null, zc: null, status: atypical ? 'atypical' : 'normal' };
  }

  const z  = (value - n.mean) / n.sd;
  const zc = n.higherIsBetter ? z : -z;
  const status = zc <= -1.5 ? 'deficit' : zc >= 1.5 ? 'hyper' : 'normal';
  return { z, zc, status };
}

// Format the Z-score phrase used in clinical notes.
function zPhrase(testKey, value) {
  const { z } = classify(testKey, value);
  const n = NORMATIVE[testKey] ?? {};
  if (z == null) return `${value}${n.unit ?? ''} (cut-off ≥ ${n.cutoff})`;
  return `${value}${n.unit ?? ''} (z = ${z >= 0 ? '+' : ''}${z.toFixed(2)} vs norm ${n.mean}±${n.sd}${n.unit ?? ''})`;
}

// ─── AAL region centroid MNI coordinates (approximate, mm) ────────────────────
// Used by app.js to place lightweight "abstract node" glow points on the GLB mesh
// instead of rendering the full AAL voxel atlas — keyed by the same AAL integer
// label codes referenced in each tract's `aalRegions` array above.
export const AAL_CENTROID_MNI = {
  1:  [-39,  -6,  51], 2:  [ 41,  -8,  52],   // Precentral L/R
  3:  [-19,  31,  41], 4:  [ 21,  30,  40],   // Frontal_Sup L/R
  7:  [-33,  32,  35], 8:  [ 37,  33,  34],   // Frontal_Mid L/R
  11: [-48,  13,  17], 12: [ 50,  15,  18],   // Frontal_Inf_Oper L/R
  13: [-46,  29,  13], 14: [ 48,  29,  14],   // Frontal_Inf_Tri L/R
  19: [ -6,   3,  60], 20: [  8,   3,  61],   // Supp_Motor_Area L/R
  23: [ -6,  49,  31], 24: [  9,  49,  32],   // Frontal_Sup_Medial L/R
  25: [ -6,  49,  -8], 26: [  7,  50,  -8],   // Frontal_Med_Orb L/R
  27: [ -5,  35, -18], 28: [  7,  34, -18],   // Rectus L/R
  31: [ -4,  35,  14], 32: [  7,  35,  16],   // Cingulum_Ant L/R
  37: [-25, -21, -10], 38: [ 27, -20, -10],   // Hippocampus L/R
  39: [-21, -16, -21], 40: [ 24, -15, -20],   // ParaHippocampal L/R
  41: [-23,  -3, -18], 42: [ 25,  -2, -18],   // Amygdala L/R
  49: [-16, -85,  26], 50: [ 20, -83,  27],   // Occipital_Sup L/R
  51: [-33, -80,  17], 52: [ 36, -79,  20],   // Occipital_Mid L/R
  53: [-34, -80,  -8], 54: [ 37, -78,  -7],   // Occipital_Inf L/R
  59: [-23, -60,  55], 60: [ 26, -59,  56],   // Parietal_Sup L/R
  61: [-43, -49,  46], 62: [ 45, -47,  47],   // Parietal_Inf L/R
  81: [-56, -35,  -6], 82: [ 57, -33,  -6],   // Temporal_Mid L/R
  85: [-55, -21,   7], 86: [ 57, -20,   7],   // Temporal_Sup L/R
  89: [-39,  15, -20], 90: [ 41,  15, -19],   // Temporal_Pole_Sup L/R
  // ── High-density expansion: deep grey-matter structures + network hubs ──────
  29: [-35,   7,   3], 30: [ 39,   6,   2],   // Insula L/R (salience hub)
  65: [-44, -61,  36], 66: [ 46, -60,  39],   // Angular gyrus L/R (DMN hub)
  67: [ -7, -56,  48], 68: [ 10, -56,  44],   // Precuneus / posterior cingulate L/R (DMN hub)
  71: [-11,  11,   9], 72: [ 14,  12,   9],   // Caudate L/R (basal ganglia)
  73: [-24,   4,   2], 74: [ 28,   5,   2],   // Putamen L/R (basal ganglia)
  75: [-17,  -1,   0], 76: [ 21,   0,   0],   // Pallidum L/R (basal ganglia)
  77: [-11, -18,   8], 78: [ 13, -18,   8],   // Thalamus L/R
};

// ─── Resting-state networks & deep-structure graph (high-density connectome) ──
// Rendered by app.js as SIMPLE additive spheres + thin tubes (graph-theory look),
// never voxel shapes — integrated-GPU safe. Colours identify each network.
export const RS_NETWORKS = {
  DMN:      { label: 'Default Mode',       color: 0x4fd1ff, nodes: [23, 24, 67, 68, 65, 66, 37, 38] },
  Salience: { label: 'Salience',           color: 0xff9d4f, nodes: [29, 30, 31, 32] },
  CEN:      { label: 'Central Executive',  color: 0x9d7bff, nodes: [7, 8, 59, 60, 61, 62] },
  BG:       { label: 'Basal Ganglia–Thalamus', color: 0x59e0a8, nodes: [71, 72, 73, 74, 75, 76, 77, 78] },
};

// Deep-structure / hub nodes that are always rendered even without a linked test.
export const DEEP_NODES = [29, 30, 65, 66, 67, 68, 71, 72, 73, 74, 75, 76, 77, 78];

// Functional / structural edges between the network nodes (AAL index pairs).
export const NETWORK_EDGES = [
  // Default Mode Network
  { net: 'DMN', a: 23, b: 67 }, { net: 'DMN', a: 24, b: 68 },
  { net: 'DMN', a: 67, b: 65 }, { net: 'DMN', a: 68, b: 66 },
  { net: 'DMN', a: 23, b: 37 }, { net: 'DMN', a: 24, b: 38 },
  { net: 'DMN', a: 65, b: 37 }, { net: 'DMN', a: 66, b: 38 },
  // Salience Network
  { net: 'Salience', a: 29, b: 31 }, { net: 'Salience', a: 30, b: 32 }, { net: 'Salience', a: 29, b: 30 },
  // Central Executive (frontoparietal)
  { net: 'CEN', a: 7, b: 59 }, { net: 'CEN', a: 8, b: 60 }, { net: 'CEN', a: 7, b: 61 }, { net: 'CEN', a: 8, b: 62 },
  // Basal-ganglia → thalamo-cortical loop
  { net: 'BG', a: 71, b: 73 }, { net: 'BG', a: 72, b: 74 },
  { net: 'BG', a: 73, b: 75 }, { net: 'BG', a: 74, b: 76 },
  { net: 'BG', a: 75, b: 77 }, { net: 'BG', a: 76, b: 78 },
  { net: 'BG', a: 77, b: 7 },  { net: 'BG', a: 78, b: 8 },
  { net: 'BG', a: 77, b: 1 },  { net: 'BG', a: 78, b: 2 },
];

export const CONNECTOME_DATABASE = {

  // ─── Corsi Block-Tapping → Fornix / Hippocampal–Parahippocampal Circuit ──────
  // AAL: Hippocampus_L [37], Hippocampus_R [38], ParaHippocampal_L [39], ParaHippocampal_R [40]
  corsi: {
    testName: 'Corsi Block-Tapping Test',
    clinicalProxy: 'Visuospatial / Episodic Memory — Hippocampal–Fornix circuit',
    tracts: [{
      name: 'Fornix (Hippocampal–Parahippocampal Circuit)',
      key: 'fornix',
      from: 'leftHippocampus',
      to:   'rightHippocampus',
      aalRegions: [37, 38, 39, 40],   // Hippocampus_L/R + ParaHippocampal_L/R
      getStatus: v => classify('corsi', v).status,
      insight: {
        normal: 'The fornix is the principal output tract of the hippocampus, carrying spatial and episodic memory traces to the mammillary bodies and anterior thalamus. Parahippocampal cortex provides contextual binding.',
        measures: "Forward and backward Corsi spans index the hippocampus's capacity to encode, hold, and (in reverse) manipulate spatial sequences. The fwd+bwd mean is the standard clinical composite.",
        pathophysiology: 'A span ≥ 1.5 SD below norm (Kessels et al., 2000: M=6.0, SD=1.1) is modelled as reduced fornix FA — microstructural change in hippocampal output integrity.',
      },
      getNote: (v, status) => {
        if (status === 'deficit')
          return `Corsi span ${zPhrase('corsi', v)} ≤ −1.5 SD. Fornix FA variance modelled — reduced hippocampal output integrity (Douet & Chang, 2015; Kessels et al., 2000).`;
        if (status === 'hyper')
          return `Corsi span ${zPhrase('corsi', v)} ≥ +1.5 SD (supra-normal). Fornix modelled with expanded FA — exceptional hippocampal–parahippocampal output integrity.`;
        return `Corsi span ${zPhrase('corsi', v)} within normative range. Fornix microstructure modelled as intact (Toepper et al., 2010).`;
      },
      citations: [
        'Kessels, R. P. C., et al. (2000). The Corsi Block-Tapping Task: standardization and normative data. Applied Neuropsychology, 7(4), 252–258.',
        'Toepper, M., et al. (2010). Hippocampal involvement in working memory encoding of changing locations. Brain Research, 1354, 91–99.',
        'Douet, V., & Chang, L. (2015). Fornix as an imaging marker for episodic memory deficits. Frontiers in Aging Neuroscience, 6, 343.',
      ],
    }],
  },

  // ─── 2-Back Working Memory → SLF-II ─────────────────────────────────────────
  nback: {
    testName: '2-Back Working Memory (continuous)',
    clinicalProxy: 'Central Executive — Frontoparietal maintenance (PPC ↔ dlPFC)',
    tracts: [{
      name: 'Superior Longitudinal Fasciculus II (SLF-II)',
      key: 'slf2',
      from: 'leftParietal',
      to:   'leftDLPFC',
      aalRegions: [59, 61, 7, 8],     // Parietal_Sup_L/R + Frontal_Mid_L/R (SLF-II endpoints)
      getStatus: v => classify('nback', v).status,
      insight: {
        normal: 'SLF-II is the dorsal-attention highway linking posterior parietal cortex to dorsolateral prefrontal cortex, sustaining online maintenance and manipulation of working-memory representations.',
        measures: 'A continuous 2-back stream scored as Hits − False Alarms (signal detection) prevents response-bias inflation and indexes true frontoparietal bandwidth.',
        pathophysiology: 'Corrected detection ≥ 1.5 SD below norm is modelled as reduced SLF-II FA — degraded parietal–prefrontal transmission speed (Vestergaard et al., 2011).',
      },
      getNote: (v, status) => {
        if (status === 'deficit')
          return `Corrected detection ${zPhrase('nback', v)} ≤ −1.5 SD. SLF-II FA variance modelled — reduced frontoparietal bandwidth (Vestergaard et al., 2011; Owen et al., 2005).`;
        if (status === 'hyper')
          return `Corrected detection ${zPhrase('nback', v)} ≥ +1.5 SD. SLF-II modelled with elevated FA — robust frontoparietal maintenance bandwidth.`;
        return `Corrected detection ${zPhrase('nback', v)} within norm. SLF-II models intact frontoparietal connectivity.`;
      },
      citations: [
        'Vestergaard, M., et al. (2011). White matter microstructure in SLF and spatial working memory. Journal of Cognitive Neuroscience, 23(9), 2135–2146.',
        'Owen, A. M., et al. (2005). N-back working memory paradigm: a meta-analysis. Human Brain Mapping, 25(1), 46–59.',
      ],
    }],
  },

  // ─── Stroop Interference → Cingulum Bundle (dACC → dlPFC) ───────────────────
  // AAL: Cingulum_Ant_L [31], Cingulum_Ant_R [32], Frontal_Mid_L [7], Frontal_Mid_R [8]
  stroop: {
    testName: 'Stroop Interference (block design)',
    clinicalProxy: 'Conflict Monitoring / Executive Control — Cingulo-frontal',
    tracts: [{
      name: 'Cingulum Bundle (dACC → dlPFC)',
      key: 'cingulum',
      from: 'anteriorCingulate',
      to:   'leftDLPFC',
      aalRegions: [31, 32, 7, 8],     // Cingulum_Ant_L/R [31,32] + Frontal_Mid_L/R [7,8]
      getStatus: v => classify('stroop', v).status,
      insight: {
        normal: 'The cingulum bundle connects the dorsal anterior cingulate cortex (conflict detection) to the dorsolateral prefrontal cortex (top-down inhibitory control), forming the core executive-control circuit.',
        measures: 'A block design — 30 congruent then 30 incongruent trials — isolates the RT cost of conflict (incongruent − congruent ms). Lower interference cost = more efficient cingulo-frontal inhibition.',
        pathophysiology: 'An interference RT cost ≥ 1.5 SD above norm (van Boxtel et al., 2001: M=82.6ms, SD=48ms) is modelled as reduced cingulum FA — degraded dACC–dlPFC conflict resolution (MacDonald et al., 2000).',
      },
      getNote: (v, status) => {
        if (status === 'deficit')
          return `Interference cost ${zPhrase('stroop', v)} ≥ +1.5 SD above norm (slower). Cingulum FA variance modelled — reduced conflict-resolution efficiency (MacDonald et al., 2000; van Boxtel et al., 2001).`;
        if (status === 'hyper')
          return `Interference cost ${zPhrase('stroop', v)} ≥ 1.5 SD below norm (exceptionally fast). Cingulum modelled with elevated FA — highly efficient dACC–dlPFC conflict resolution.`;
        return `Interference cost ${zPhrase('stroop', v)} within norm. Cingulum models intact dACC–dlPFC inhibitory control.`;
      },
      citations: [
        'MacDonald, A. W., et al. (2000). Dissociating dlPFC and ACC in cognitive control. Science, 288(5472), 1835–1838.',
        'van Boxtel, G. J. M., et al. (2001). Stroop interference and the anterior cingulate. Brain and Cognition, 45(1), 138–158.',
        'Scarpina, F., & Tagini, S. (2017). The Stroop Color and Word Test. Frontiers in Psychology, 8, 557.',
      ],
    }],
  },

  // ─── RSVP Reading → Arcuate Fasciculus ──────────────────────────────────────
  rsvp: {
    testName: 'RSVP Reading Speed Test',
    clinicalProxy: 'Language Network — Arcuate Fasciculus (Wernicke ↔ Broca)',
    tracts: [{
      name: 'Arcuate Fasciculus (Wernicke → Broca)',
      key: 'arcuate',
      from: 'leftTemporal',
      to:   'leftIFG',
      aalRegions: [85, 89, 81, 11, 13],  // Temporal_Sup_L [85], Temporal_Pole_Sup_L [89], Temporal_Mid_L [81], IFG_Oper_L [11], IFG_Tri_L [13]
      getStatus: v => classify('rsvp', v).status,
      insight: {
        normal: 'The arcuate fasciculus is the dorsal language pathway linking posterior temporal comprehension cortex (Wernicke) to the inferior frontal gyrus (Broca) for syntactic assembly.',
        measures: 'RSVP forces high-speed temporal–frontal hand-off; the comprehension index captures semantic decoding under time pressure — a sensitive probe of arcuate transmission speed.',
        pathophysiology: 'A comprehension index ≥ 1.5 SD below norm is modelled as reduced arcuate FA — slowed frontotemporal language transmission (MacPherson et al., 2017).',
      },
      getNote: (v, status) => {
        if (status === 'deficit')
          return `Reading index ${zPhrase('rsvp', v)} ≤ −1.5 SD. Arcuate fasciculus FA variance modelled — reduced dorsal-stream language transmission (MacPherson et al., 2017).`;
        if (status === 'hyper')
          return `Reading index ${zPhrase('rsvp', v)} ≥ +1.5 SD. Arcuate fasciculus modelled with elevated FA — rapid frontotemporal language transmission.`;
        return `Reading index ${zPhrase('rsvp', v)} within norm. Arcuate fasciculus models intact dorsal-stream language processing.`;
      },
      citations: [
        'Catani, M., & Mesulam, M. (2008). The arcuate fasciculus and the disconnection theme in language and aphasia. Cortex, 44(8), 953–961.',
        'MacPherson, S. E., et al. (2017). Processing speed, cortical thinning and white matter microstructure. Cortex, 95, 92–103.',
      ],
    }],
  },

  // ─── Verbal Fluency (FAS) → Frontal Aslant Tract ────────────────────────────
  // AAL: Frontal_Inf_Oper_L [11], Frontal_Inf_Oper_R [12], Frontal_Inf_Tri_L [13], Frontal_Inf_Tri_R [14]
  verbalFluency: {
    testName: 'Verbal Fluency — FAS (3 × 60 s)',
    clinicalProxy: "Lexical Retrieval / Broca's Area — Frontal Aslant Tract",
    tracts: [{
      name: "Frontal Aslant Tract (Broca → pre-SMA / dlPFC)",
      key: 'fat',
      from: 'leftIFG',
      to:   'leftDLPFC',
      aalRegions: [11, 12, 13, 14],   // Frontal_Inf_Oper_L/R [11,12] + Frontal_Inf_Tri_L/R [13,14]
      getStatus: v => classify('verbalFluency', v).status,
      insight: {
        normal: "The frontal aslant tract connects Broca's area (inferior frontal gyrus, pars opercularis + triangularis) to pre-SMA/dlPFC, driving the initiation and strategic fluency of self-generated speech.",
        measures: 'Three 60-second phonemic blocks (F, A, S) summed to a FAS total — the standard clinical index of strategic, Broca-driven lexical search (Tombaugh et al., 1999: M=42.5, SD=11.2).',
        pathophysiology: 'A FAS total ≥ 1.5 SD below norm is modelled as reduced FAT FA — effortful verbal initiation reflecting degraded Broca–pre-SMA circuit integrity (Catani et al., 2013).',
      },
      getNote: (v, status) => {
        if (status === 'deficit')
          return `FAS total ${zPhrase('verbalFluency', v)} ≤ −1.5 SD. Frontal aslant tract FA variance modelled — effortful Broca-driven retrieval (Catani et al., 2013; Tombaugh et al., 1999).`;
        if (status === 'hyper')
          return `FAS total ${zPhrase('verbalFluency', v)} ≥ +1.5 SD. Frontal aslant tract modelled with elevated FA — exceptional Broca–pre-SMA initiation and lexical fluency.`;
        return `FAS total ${zPhrase('verbalFluency', v)} within norm. Frontal aslant tract models efficient Broca–pre-SMA initiation.`;
      },
      citations: [
        'Catani, M., et al. (2013). A novel frontal pathway underlies verbal fluency in primary progressive aphasia. Brain, 136(8), 2619–2628.',
        'Tombaugh, T. N., et al. (1999). Normative data for the COWAT (FAS). Archives of Clinical Neuropsychology, 14(2), 167–177.',
      ],
    }],
  },

  // ─── AQ-10 → Autism-Spectrum pathophysiology profile ────────────────────────
  // NICE-recommended 10-item screener. Score ≥ 6 → atypical → dual signature:
  //   • Long-range HYPO: diminished Uncinate (amygdala ↔ vmPFC)   → 'deficit'
  //   • Local frontal HYPER: elevated short-range IFG/dlPFC density → 'hyper'
  // AAL Social Cognition set: Amygdala_L [41], Amygdala_R [42],
  //   Frontal_Med_Orb_L [25], Frontal_Med_Orb_R [26], Rectus_L [27], Rectus_R [28]
  aq10: {
    testName: 'AQ-10 Autism-Spectrum Quotient',
    clinicalProxy: 'Autism-Spectrum traits — frontal hyper- + long-range hypo-connectivity',
    profile: 'autism_spectrum',
    tracts: [
      {
        name: 'Uncinate Fasciculus (Amygdala → vmPFC)',
        key: 'uf',
        from: 'leftAmygdala',
        to:   'leftVmPFC',
        aalRegions: [41, 42, 25, 26, 27, 28],  // Amygdala_L/R + Frontal_Med_Orb_L/R + Rectus_L/R
        getStatus: v => classify('aq10', v).status === 'atypical' ? 'deficit' : 'normal',
        insight: {
          normal: 'The uncinate fasciculus is the principal long-range tract bridging the amygdala to the ventromedial/orbitofrontal cortex, integrating emotional salience with social regulation.',
          measures: 'The AQ-10 (NICE-recommended) screens social cognition, attention-switching, communication and imagination; ≥ 6 indicates likely autistic traits warranting clinical referral.',
          pathophysiology: 'AQ-10 ≥ 6 is modelled as reduced uncinate FA — the long-range amygdala–vmPFC under-connectivity that is one of the most replicated DTI findings in autism (Rane et al., 2015).',
        },
        getNote: (v, status) => status === 'deficit'
          ? `AQ-10 ${zPhrase('aq10', v)} — screen positive. Uncinate modelled with reduced FA — long-range amygdala–vmPFC hypo-connectivity (Rane et al., 2015; Li et al., 2021).`
          : `AQ-10 ${zPhrase('aq10', v)} — below threshold. Uncinate modelled as intact amygdala–vmPFC integration.`,
        citations: [
          'Allison, C., Auyeung, B., & Baron-Cohen, S. (2012). Toward brief "Red Flags" for autism screening: the AQ-10. JAACAP, 51(2), 202–212.',
          'Rane, P., et al. (2015). Connectivity in autism: a review of MRI connectivity studies. Harvard Review of Psychiatry, 23(4), 223–244.',
          'Li, Y., et al. (2021). Structural connectivity of the uncinate fasciculus in ASD. NeuroImage: Clinical, 30, 102630.',
        ],
      },
      {
        name: 'Local Frontal Connectivity (IFG ↔ dlPFC)',
        key: 'frontalLocal',
        from: 'leftIFG',
        to:   'leftDLPFC',
        aalRegions: [11, 12, 13, 14],   // Frontal_Inf_Oper_L/R + Frontal_Inf_Tri_L/R
        getStatus: v => classify('aq10', v).status === 'atypical' ? 'hyper' : 'normal',
        insight: {
          normal: 'Short-range association fibres within the frontal lobe support local circuit computation across the inferior and dorsolateral prefrontal cortex.',
          measures: 'The same AQ-10 trait load that diminishes long-range tracts is paired in the model with intensified local frontal processing — the hallmark "local over-, global under-" connectivity signature.',
          pathophysiology: 'AQ-10 ≥ 6 is modelled as local frontal HYPER-connectivity — increased short-range IFG/dlPFC density (Courchesne & Pierce, 2005).',
        },
        getNote: (v, status) => status === 'hyper'
          ? `AQ-10 ${zPhrase('aq10', v)} — screen positive. Local frontal circuitry modelled as HYPER-connected — increased short-range IFG/dlPFC density (Courchesne & Pierce, 2005).`
          : `AQ-10 ${zPhrase('aq10', v)} — below threshold. Local frontal connectivity modelled as balanced.`,
        citations: [
          'Courchesne, E., & Pierce, K. (2005). Local over-connectivity in autism. Current Opinion in Neurobiology, 15(2), 225–230.',
          'Allison, C., et al. (2012). The AQ-10. JAACAP, 51(2), 202–212.',
        ],
      },
    ],
  },

  // ─── Finger Tapping Test → Corticospinal Tract & SMA ────────────────────────
  // AAL: Precentral_L [1], Precentral_R [2], Supp_Motor_Area_L [19], Supp_Motor_Area_R [20]
  fingerTapping: {
    testName: 'Finger Tapping Test',
    clinicalProxy: 'Motor Speed & Corticospinal Integrity — Precentral Gyrus / SMA',
    tracts: [{
      name: 'Corticospinal Tract & SMA (M1 ↔ Supplementary Motor Area)',
      key: 'cst',
      from: 'leftPrecentral',
      to:   'rightPrecentral',
      aalRegions: [1, 2, 19, 20],     // Precentral_L/R [1,2] + Supp_Motor_Area_L/R [19,20]
      getStatus: v => classify('fingerTapping', v).status,
      insight: {
        normal: 'The corticospinal tract descends from primary motor cortex (M1 / precentral gyrus) and the supplementary motor area (SMA) to drive precise, rapid voluntary movement via pyramidal fibres.',
        measures: 'Dominant-hand taps per 10 seconds (standard FTT protocol) indexes corticospinal transmission speed and SMA motor planning efficiency (Ruff & Parker, 1993: M=55, SD=8).',
        pathophysiology: 'A tapping rate ≥ 1.5 SD below norm is modelled as reduced CST FA — slowed motor signal propagation from SMA/M1, consistent with early corticospinal degeneration.',
      },
      getNote: (v, status) => {
        if (status === 'deficit')
          return `Tapping rate ${zPhrase('fingerTapping', v)} ≤ −1.5 SD. Corticospinal tract FA variance modelled — reduced motor transmission speed (Ruff & Parker, 1993).`;
        if (status === 'hyper')
          return `Tapping rate ${zPhrase('fingerTapping', v)} ≥ +1.5 SD (supra-normal motor speed). CST modelled with elevated FA — exceptional M1/SMA transmission efficiency.`;
        return `Tapping rate ${zPhrase('fingerTapping', v)} within normative range. Corticospinal tract modelled as intact.`;
      },
      citations: [
        'Ruff, R. M., & Parker, S. B. (1993). Gender- and age-specific changes in motor speed and eye-hand coordination in adults. Archives of Clinical Neuropsychology, 8(4), 359–382.',
        'Mutha, P. K., et al. (2012). The effects of brain lateralization on motor control and adaptation. Journal of Motor Behavior, 44(6), 455–469.',
      ],
    }],
  },

  // ─── Go/No-Go → Right-Lateralised Response-Inhibition Network ────────────────
  // NEW (TBI / neurosurgical triage). Response inhibition is among the most
  // sensitive markers of frontal disinhibition after TBI. The canonical circuit
  // is right IFG (rIFG) → pre-SMA → subthalamic "stopping" pathway, with dACC
  // conflict monitoring. Metric: commission-error rate on No-Go trials (lower =
  // better inhibitory control).
  // AAL: Frontal_Inf_Oper_R [12], Frontal_Inf_Tri_R [14], Supp_Motor_Area_R [20],
  //      Cingulum_Ant_R [32]
  goNoGo: {
    testName: 'Go/No-Go Inhibitory Control',
    clinicalProxy: 'Response Inhibition — right IFG → pre-SMA stopping network',
    profile: 'tbi_disinhibition',
    tracts: [{
      name: 'Right IFG → pre-SMA (Stopping Pathway)',
      key: 'stoppingRight',
      from: 'rightIFG',
      to:   'rightSMA',
      aalRegions: [12, 14, 20, 32],
      getStatus: v => classify('goNoGo', v).status,
      insight: {
        normal: 'The right inferior frontal gyrus, acting through the pre-supplementary motor area and the hyperdirect subthalamic pathway, implements rapid action cancellation — the neural "brake" that suppresses a prepotent motor response.',
        measures: 'Commission errors on No-Go trials (responding when you should withhold) index the integrity of this stopping network. A block with ~75% Go trials builds prepotency so No-Go withholding is genuinely effortful.',
        pathophysiology: 'A commission-error rate ≥ 1.5 SD above norm is modelled as reduced rIFG–preSMA connectivity — the frontal disinhibition profile characteristic of orbitofrontal/frontal TBI and a red flag for impulsivity in surgical triage (Aron et al., 2014).',
      },
      getNote: (v, status) => {
        if (status === 'deficit')
          return `Commission-error rate ${zPhrase('goNoGo', v)} ≥ +1.5 SD. Right IFG→pre-SMA stopping pathway modelled with reduced connectivity — frontal disinhibition signature (Aron et al., 2014; Criaud & Boulinguez, 2013).`;
        if (status === 'hyper')
          return `Commission-error rate ${zPhrase('goNoGo', v)} ≥ 1.5 SD below norm — exceptionally tight inhibitory control. Stopping pathway modelled as supra-normal.`;
        return `Commission-error rate ${zPhrase('goNoGo', v)} within norm. Right-lateralised stopping network modelled as intact.`;
      },
      citations: [
        'Aron, A. R., Robbins, T. W., & Poldrack, R. A. (2014). Inhibition and the right inferior frontal cortex: one decade on. Trends in Cognitive Sciences, 18(4), 177–185.',
        'Criaud, M., & Boulinguez, P. (2013). Have we been asking the right questions when assessing response inhibition in go/no-go tasks? Neuroscience & Biobehavioral Reviews, 37(1), 11–23.',
        'Dockree, P. M., et al. (2006). Sustained attention in traumatic brain injury and healthy controls. Experimental Brain Research, 168(1–2), 218–229.',
      ],
    }],
  },

  // ─── Trail Making Test B → Frontoparietal Set-Shifting Network ──────────────
  // NEW (TBI / neurosurgical triage). TMT-B (alternating number–letter sequencing)
  // is a workhorse of neuropsychological triage: sensitive to processing speed,
  // divided attention and cognitive flexibility. Metric: completion time (lower =
  // better). The dorsal frontoparietal set-shifting network (dlPFC ↔ posterior
  // parietal, via SLF) plus dACC underlies task-set reconfiguration.
  // AAL: Frontal_Mid_L/R [7,8], Parietal_Sup_L/R [59,60], Cingulum_Ant_L/R [31,32]
  trailsB: {
    testName: 'Trail Making Test — Part B',
    clinicalProxy: 'Cognitive Flexibility / Set-Shifting — frontoparietal (dlPFC ↔ PPC)',
    profile: 'tbi_processing_speed',
    tracts: [{
      name: 'Frontoparietal Set-Shifting Network (dlPFC ↔ PPC)',
      key: 'setShifting',
      from: 'leftDLPFC',
      to:   'leftParietal',
      aalRegions: [7, 8, 59, 60, 31, 32],
      getStatus: v => classify('trailsB', v).status,
      insight: {
        normal: 'Alternating between numeric and alphabetic sequences requires the dorsolateral prefrontal cortex to reconfigure task-set while the posterior parietal cortex maintains the visuospatial search — coupled through the superior longitudinal fasciculus with anterior cingulate conflict monitoring.',
        measures: 'TMT-B completion time (seconds) is the standard clinical index; the B−A difference isolates the pure set-shifting cost from raw visuomotor speed. Prolonged times flag reduced frontoparietal bandwidth.',
        pathophysiology: 'A completion time ≥ 1.5 SD above norm is modelled as reduced frontoparietal white-matter integrity — a common diffuse-axonal-injury signature after TBI and a strong predictor of return-to-work capacity (Sánchez-Cubillo et al., 2009).',
      },
      getNote: (v, status) => {
        if (status === 'deficit')
          return `TMT-B time ${zPhrase('trailsB', v)} ≥ +1.5 SD (slowed). Frontoparietal set-shifting network modelled with reduced connectivity — diffuse-axonal-injury signature (Sánchez-Cubillo et al., 2009; Reitan, 1958).`;
        if (status === 'hyper')
          return `TMT-B time ${zPhrase('trailsB', v)} ≥ 1.5 SD below norm — exceptionally fast set-shifting. Frontoparietal network modelled as supra-normal.`;
        return `TMT-B time ${zPhrase('trailsB', v)} within norm. Frontoparietal set-shifting network modelled as intact.`;
      },
      citations: [
        'Reitan, R. M. (1958). Validity of the Trail Making Test as an indicator of organic brain damage. Perceptual and Motor Skills, 8, 271–276.',
        'Sánchez-Cubillo, I., et al. (2009). Construct validity of the Trail Making Test. Journal of the International Neuropsychological Society, 15(3), 438–450.',
        'Tombaugh, T. N. (2004). Trail Making Test A and B: normative data stratified by age and education. Archives of Clinical Neuropsychology, 19(2), 203–214.',
      ],
    }],
  },

};
