/* =========================================================
   AUDIOMETRY — at-home hearing assessment
   Vanilla JS, Web Audio API, localStorage
   ========================================================= */

(() => {
'use strict';

/* ---------- Constants ---------- */
const STORAGE_KEY = 'audiometry.v1';
const FREQS_FULL  = [250, 500, 1000, 2000, 3000, 4000, 6000, 8000];
const FREQS_QUICK = [500, 1000, 2000, 4000];
const PTA_FREQS   = [500, 1000, 2000];

/* dB HL bounds we will present */
const HL_MIN = -10;
const HL_MAX = 90;

/* Reference-tone gain anchor.
   At this gain, after the user adjusts SYSTEM volume so the tone sounds
   like quiet conversation, we treat the SPL as ~60 dB HL.
   Headroom above the reference: 20*log10(1/0.04) ≈ 28 dB → max ~88 dB HL */
const REFERENCE_GAIN = 0.04;
const REFERENCE_DBHL = 60;

/* ---------- State ---------- */
const state = {
  view: 'home',
  cal: null,                 // { gain, trim, ts, channelsConfirmed }
  history: [],               // [{ id, ts, mode, freqs, results: { right: {hz: db}, left: {hz: db} } }]
  tinnitusMatches: [],       // [{ ts, freq, level, type, side }]
  test: null,                // active test object (see startTest)
  audio: null,               // AudioContext + helper nodes
  meter: null,               // active noise meter
};

/* ---------- Storage ---------- */
const Storage = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      if (obj.cal)              state.cal = obj.cal;
      if (obj.history)          state.history = obj.history;
      if (obj.tinnitusMatches)  state.tinnitusMatches = obj.tinnitusMatches;
    } catch (err) { console.warn('storage.load', err); }
  },
  save() {
    const obj = {
      cal: state.cal,
      history: state.history,
      tinnitusMatches: state.tinnitusMatches,
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); }
    catch (err) { console.warn('storage.save', err); }
  },
};

/* ---------- DOM helpers ---------- */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const fmtDate = (ts) => {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
};
const fmtDateTime = (ts) => {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const fmtHz = (hz) => hz >= 1000 ? `${(hz/1000).toFixed(hz % 1000 ? 1 : 0)} kHz` : `${hz} Hz`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

const toast = (msg, ms = 2200) => {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
};

const modal = {
  open(html) {
    $('#modal-body').innerHTML = html;
    $('#modal').hidden = false;
  },
  close() { $('#modal').hidden = true; },
};

/* ---------- Router ---------- */
const Router = {
  go(view) {
    state.view = view;
    $$('.view').forEach(v => v.hidden = v.dataset.view !== view);
    $$('.topnav a').forEach(a => a.classList.toggle('active', a.dataset.route === view));
    if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    onViewEnter(view);
  },
  init() {
    const fromHash = (location.hash || '#home').slice(1);
    Router.go(fromHash);
    window.addEventListener('hashchange', () => {
      const v = (location.hash || '#home').slice(1);
      Router.go(v);
    });
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-route]');
      if (t) {
        e.preventDefault();
        Router.go(t.dataset.route);
      }
    });
  },
};

/* ---------- Audio engine ---------- */
const Audio = {
  ctx: null,
  master: null,

  ensure() {
    if (this.ctx) return this.ctx;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 1.0;
    this.master.connect(ctx.destination);
    $('#audio-status').classList.add('live');
    return ctx;
  },

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') return this.ctx.resume();
    return Promise.resolve();
  },

  /* Compute linear gain for a given dB HL relative to the user's reference. */
  gainFromHL(dbHL) {
    const refGain = (state.cal && state.cal.gain) || REFERENCE_GAIN;
    const trim    = (state.cal && state.cal.trim) || 0;
    const dbAdjust = dbHL - REFERENCE_DBHL + trim;
    const g = refGain * Math.pow(10, dbAdjust / 20);
    return Math.max(0.000001, Math.min(1.0, g));
  },

  /* Play a pure tone with cosine-ramped envelope, optional channel routing. */
  playTone({ freq = 1000, dbHL = 30, durationMs = 1000, ear = 'both', envelope = 30 } = {}) {
    const ctx = this.ensure();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const env = ctx.createGain();
    env.gain.value = 0;

    /* Channel routing — silence the unused side */
    const merger = ctx.createChannelMerger(2);
    const leftGain  = ctx.createGain();
    const rightGain = ctx.createGain();
    leftGain.gain.value  = (ear === 'left'  || ear === 'both') ? 1 : 0;
    rightGain.gain.value = (ear === 'right' || ear === 'both') ? 1 : 0;

    osc.connect(env);
    env.connect(leftGain);
    env.connect(rightGain);
    leftGain.connect(merger, 0, 0);
    rightGain.connect(merger, 0, 1);
    merger.connect(this.master);

    const peak = this.gainFromHL(dbHL);
    const ramp = envelope / 1000;
    const dur  = durationMs / 1000;
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(peak, now + ramp);
    env.gain.setValueAtTime(peak, now + dur - ramp);
    env.gain.linearRampToValueAtTime(0, now + dur);

    osc.start(now);
    osc.stop(now + dur + 0.01);

    return { stop: () => { try { osc.stop(); } catch (e) {} }, endsAt: now + dur };
  },

  /* Continuous oscillator for tinnitus / reference. */
  startContinuous({ freq = 1000, level = -30, ear = 'both', type = 'sine', bandwidth = 200 } = {}) {
    const ctx = this.ensure();
    const now = ctx.currentTime;

    let source, filter = null;

    if (type === 'sine') {
      source = ctx.createOscillator();
      source.type = 'sine';
      source.frequency.value = freq;
    } else {
      /* narrowband noise via white noise + bandpass */
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      source = ctx.createBufferSource();
      source.buffer = buf;
      source.loop = true;
      filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = freq;
      filter.Q = freq / Math.max(40, bandwidth);
    }

    const env = ctx.createGain();
    env.gain.value = 0;

    const merger = ctx.createChannelMerger(2);
    const leftGain  = ctx.createGain();
    const rightGain = ctx.createGain();
    leftGain.gain.value  = (ear === 'left'  || ear === 'both') ? 1 : 0;
    rightGain.gain.value = (ear === 'right' || ear === 'both') ? 1 : 0;

    if (filter) { source.connect(filter); filter.connect(env); }
    else { source.connect(env); }
    env.connect(leftGain);
    env.connect(rightGain);
    leftGain.connect(merger, 0, 0);
    rightGain.connect(merger, 0, 1);
    merger.connect(this.master);

    const target = Math.pow(10, level / 20);
    env.gain.linearRampToValueAtTime(target, now + 0.05);
    source.start(now);

    return {
      setLevel(db) {
        env.gain.cancelScheduledValues(ctx.currentTime);
        env.gain.linearRampToValueAtTime(Math.pow(10, db / 20), ctx.currentTime + 0.05);
      },
      setFrequency(f) {
        if (source.frequency) source.frequency.linearRampToValueAtTime(f, ctx.currentTime + 0.05);
        if (filter) filter.frequency.linearRampToValueAtTime(f, ctx.currentTime + 0.05);
      },
      setEar(ear) {
        leftGain.gain.linearRampToValueAtTime ((ear === 'left'  || ear === 'both') ? 1 : 0, ctx.currentTime + 0.05);
        rightGain.gain.linearRampToValueAtTime((ear === 'right' || ear === 'both') ? 1 : 0, ctx.currentTime + 0.05);
      },
      stop() {
        env.gain.cancelScheduledValues(ctx.currentTime);
        env.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.08);
        try { source.stop(ctx.currentTime + 0.12); } catch (e) {}
      },
    };
  },

  /* Pulsed reference tone for calibration */
  startPulsedReference() {
    if (this._ref) return;
    this._ref = this.startContinuous({
      freq: 1000,
      level: 20 * Math.log10(REFERENCE_GAIN), // dB FS
      ear: 'both',
      type: 'sine',
    });
    /* gate it on/off in pulses */
    const ctx = this.ctx;
    this._refInterval = setInterval(() => {
      if (!this._ref) return;
      const ref = this._ref;
      ref.setLevel(20 * Math.log10(REFERENCE_GAIN));
      setTimeout(() => ref && ref.setLevel(-90), 600);
    }, 1100);
  },
  stopPulsedReference() {
    if (this._refInterval) clearInterval(this._refInterval);
    this._refInterval = null;
    if (this._ref) { this._ref.stop(); this._ref = null; }
  },
};

/* ---------- Severity classification ---------- */
function classifyPTA(pta) {
  if (pta == null || isNaN(pta)) return { label: '—', key: 'unknown' };
  if (pta <= 25) return { label: 'Normal',           key: 'normal' };
  if (pta <= 40) return { label: 'Mild loss',        key: 'mild' };
  if (pta <= 55) return { label: 'Moderate',         key: 'mod' };
  if (pta <= 70) return { label: 'Mod. severe',      key: 'modsev' };
  if (pta <= 90) return { label: 'Severe',           key: 'sev' };
  return { label: 'Profound', key: 'prof' };
}

function computePTA(thresholds) {
  if (!thresholds) return null;
  const vals = PTA_FREQS.map(f => thresholds[f]).filter(v => typeof v === 'number');
  if (vals.length === 0) return null;
  return Math.round(vals.reduce((a,b) => a+b, 0) / vals.length);
}

/* ---------- Test runner ---------- */
const Test = {
  async run({ mode = 'full' } = {}) {
    if (!state.cal) {
      modal.open(`
        <h3>Calibration required</h3>
        <p>Before testing we need a reference level. The calibration takes about a minute and only needs to be repeated when you change headphones.</p>
        <div class="modal-actions">
          <button class="btn btn-primary" onclick="window.__app.calibrate()">Calibrate now</button>
          <button class="btn btn-ghost" data-modal-close>Later</button>
        </div>
      `);
      return;
    }
    await Audio.resume();

    const freqs = mode === 'quick' ? FREQS_QUICK : FREQS_FULL;
    const ears  = ['right', 'left'];
    const total = freqs.length * ears.length;

    const t = state.test = {
      mode, freqs, ears, total,
      idx: 0,
      results: { right: {}, left: {} },
      cancel: false,
      paused: false,
      // current trial state
      curEar: 'right',
      curFreq: freqs[0],
      curLevel: 40,
      lastTone: null,
      heardThisTone: false,
      reversals: [],
      lastDirection: null, // 'down' | 'up'
      trials: 0,
      startedAt: Date.now(),
    };

    Router.go('test');
    $('#test-gate').style.display = '';
    $('#test-stage').classList.remove('active');
  },

  async begin() {
    const t = state.test;
    $('#test-gate').style.display = 'none';
    $('#test-stage').classList.add('active');

    for (const ear of t.ears) {
      if (t.cancel) break;
      for (const freq of t.freqs) {
        if (t.cancel) break;
        const threshold = await this.findThreshold(ear, freq);
        if (t.cancel) break;
        t.results[ear][freq] = threshold;
        t.idx++;
        this.updateProgress();
      }
    }

    if (!t.cancel) await this.finish();
  },

  updateProgress() {
    const t = state.test;
    if (!t) return;
    $('#test-counter').textContent = `${t.idx} / ${t.total}`;
    $('#test-progress').style.width = (t.idx / t.total * 100) + '%';
    $('#freq-number').textContent = t.curFreq;
    $('#freq-region').textContent = freqRegionLabel(t.curFreq);
    const earEl = $('#test-ear-label');
    earEl.textContent = t.curEar === 'right' ? 'Right ear' : 'Left ear';
    earEl.classList.toggle('test-ear-right', t.curEar === 'right');
    earEl.classList.toggle('test-ear-left',  t.curEar === 'left');
  },

  async findThreshold(ear, freq) {
    const t = state.test;
    t.curEar = ear;
    t.curFreq = freq;
    t.curLevel = 40;
    t.reversals = [];
    t.lastDirection = null;
    t.trials = 0;
    this.updateProgress();

    /* familiarisation: ascend until heard, starting at 40 */
    let level = 40;
    let lastHeard = null;
    let direction = null;

    const maxTrials = 30;
    while (t.trials < maxTrials && !t.cancel) {
      while (t.paused && !t.cancel) await sleep(150);
      if (t.cancel) return null;

      level = Math.max(HL_MIN, Math.min(HL_MAX, level));
      t.curLevel = level;
      t.trials++;

      const heard = await this.presentTrial(ear, freq, level);
      if (t.cancel) return null;

      const newDir = heard ? 'down' : 'up';
      if (direction && newDir !== direction) {
        t.reversals.push({ level, direction: newDir });
      }
      direction = newDir;

      if (heard) lastHeard = level;

      /* termination */
      if (t.reversals.length >= 4) break;

      /* step rules */
      if (heard) {
        level -= 10;
      } else {
        level += 5;
      }

      if (level < HL_MIN || level > HL_MAX) break;
    }

    if (t.reversals.length >= 2) {
      const last2 = t.reversals.slice(-2).map(r => r.level);
      return Math.round((last2[0] + last2[1]) / 2);
    }
    return lastHeard != null ? lastHeard : null;
  },

  async presentTrial(ear, freq, level) {
    const t = state.test;
    /* random pre-tone delay 1.0–2.5s */
    await sleep(rand(1000, 2500));
    if (t.cancel) return false;

    t.heardThisTone = false;
    const vis = $('#tone-vis');
    vis.classList.add('playing');
    const toneDur = 1100;
    const tone = Audio.playTone({ freq, dbHL: level, durationMs: toneDur, ear });
    t.lastTone = tone;

    /* response window = tone duration + 1500ms grace */
    await sleep(toneDur + 1500);
    vis.classList.remove('playing');
    return t.heardThisTone;
  },

  reportResponse() {
    const t = state.test;
    if (!t) return;
    if (t.lastTone && Audio.ctx && Audio.ctx.currentTime <= t.lastTone.endsAt + 1.5) {
      t.heardThisTone = true;
      const btn = $('#btn-hear');
      btn.classList.add('flash');
      setTimeout(() => btn.classList.remove('flash'), 240);
    }
  },

  pause() {
    const t = state.test;
    if (!t) return;
    t.paused = !t.paused;
    $('#btn-pause').textContent = t.paused ? 'Resume' : 'Pause';
    if (t.paused) Audio.master && (Audio.master.gain.value = 0);
    else Audio.master && (Audio.master.gain.value = 1);
  },

  abort() {
    const t = state.test;
    if (!t) return;
    t.cancel = true;
    if (t.lastTone) try { t.lastTone.stop(); } catch (e) {}
    state.test = null;
    Router.go('home');
    toast('Test cancelled');
  },

  skip() {
    const t = state.test;
    if (!t) return;
    if (t.lastTone) try { t.lastTone.stop(); } catch (e) {}
    t.heardThisTone = false;
    t.cancel = false;
    /* mark current frequency as null and force loop to advance */
    t.results[t.curEar][t.curFreq] = null;
    /* set reversals length high so findThreshold loop exits */
    t.reversals = [{ level: t.curLevel }, { level: t.curLevel }, { level: t.curLevel }, { level: t.curLevel }];
    t.trials = 999;
  },

  async finish() {
    const t = state.test;
    const session = {
      id: 'a' + Date.now().toString(36),
      ts: Date.now(),
      mode: t.mode,
      freqs: t.freqs,
      results: t.results,
      durationSec: Math.round((Date.now() - t.startedAt) / 1000),
    };
    state.history.push(session);
    Storage.save();
    state.test = null;
    showResults(session);
  },
};

function freqRegionLabel(hz) {
  if (hz <= 250)  return 'low frequencies';
  if (hz <= 500)  return 'low-mid frequencies';
  if (hz <= 2000) return 'mid frequencies';
  if (hz <= 4000) return 'high frequencies';
  return 'high-frequency / consonant range';
}

/* ---------- Results & audiogram ---------- */
function showResults(session) {
  $('#results-title').textContent = session.mode === 'quick' ? 'Quick screening' : 'Full assessment';
  $('#results-date').textContent  = fmtDateTime(session.ts);

  drawAudiogram($('#audiogram'), session);

  const ptaR = computePTA(session.results.right);
  const ptaL = computePTA(session.results.left);
  const clsR = classifyPTA(ptaR);
  const clsL = classifyPTA(ptaL);

  $('#pta-right').textContent  = ptaR == null ? '—' : ptaR + ' dB';
  $('#pta-left').textContent   = ptaL == null ? '—' : ptaL + ' dB';
  $('#class-right').textContent = clsR.label;
  $('#class-left').textContent  = clsL.label;

  const asym = (ptaR != null && ptaL != null) ? Math.abs(ptaR - ptaL) : null;
  $('#asym-value').textContent  = asym == null ? '—' : `${asym} dB`;

  $('#plain-text').textContent  = plainSummary(ptaR, ptaL, session.results);
  renderNextSteps(session, ptaR, ptaL);

  Router.go('results');
}

function plainSummary(ptaR, ptaL, results) {
  if (ptaR == null && ptaL == null) return 'No thresholds were obtained.';
  const parts = [];
  if (ptaR != null) parts.push(`Your right-ear average was ${ptaR} dB HL (${classifyPTA(ptaR).label.toLowerCase()}).`);
  if (ptaL != null) parts.push(`Your left-ear average was ${ptaL} dB HL (${classifyPTA(ptaL).label.toLowerCase()}).`);

  /* high-frequency ski-slope check */
  const isSkiSlope = (ear) => {
    const r = results[ear];
    const lo = r[500] ?? r[1000];
    const hi = r[4000] ?? r[6000] ?? r[8000];
    return (lo != null && hi != null && hi - lo > 25);
  };
  const skiR = isSkiSlope('right');
  const skiL = isSkiSlope('left');
  if (skiR || skiL) {
    parts.push('A pronounced drop at the higher frequencies often reflects noise-induced or age-related hearing loss.');
  }

  if (ptaR != null && ptaL != null && Math.abs(ptaR - ptaL) >= 15) {
    parts.push('A noticeable difference between your two ears warrants attention from a professional.');
  }
  return parts.join(' ');
}

function renderNextSteps(session, ptaR, ptaL) {
  const ul = $('#next-steps');
  ul.innerHTML = '';
  const steps = [];
  const worst = Math.max(ptaR ?? 0, ptaL ?? 0);
  if (worst > 25) steps.push('Schedule an appointment with a licensed audiologist for a calibrated audiometric evaluation.');
  if (ptaR != null && ptaL != null && Math.abs(ptaR - ptaL) >= 15) steps.push('Asymmetric loss should always be investigated medically.');
  steps.push('Repeat this test in a quieter room or with another set of headphones to confirm the pattern.');
  steps.push('Track changes by retesting every 3–6 months.');
  steps.push('Use ear protection (29 dB NRR plugs or muffs) above 85 dBA.');
  for (const s of steps) {
    const li = document.createElement('li');
    li.textContent = s;
    ul.appendChild(li);
  }
}

function drawAudiogram(svg, session) {
  const W = 720, H = 520;
  const M = { l: 64, r: 28, t: 36, b: 64 };
  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;

  const xFreqs = [125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const xMin = Math.log2(125);
  const xMax = Math.log2(16000);
  const xScale = (hz) => M.l + (Math.log2(hz) - xMin) / (xMax - xMin) * innerW;

  const yMin = -10, yMax = 110;
  const yScale = (db) => M.t + (db - yMin) / (yMax - yMin) * innerH;

  const ns = 'http://www.w3.org/2000/svg';
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = '';

  /* severity bands */
  const bands = [
    { lo: -10, hi: 25,  fill: '#cfe1c2', op: 0.55 },
    { lo:  25, hi: 40,  fill: '#e8d8a3', op: 0.55 },
    { lo:  40, hi: 55,  fill: '#ebbf86', op: 0.55 },
    { lo:  55, hi: 70,  fill: '#db9b6f', op: 0.55 },
    { lo:  70, hi: 90,  fill: '#b0734d', op: 0.55 },
    { lo:  90, hi: 110, fill: '#6b4530', op: 0.55 },
  ];
  for (const b of bands) {
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', M.l);
    rect.setAttribute('y', yScale(b.lo));
    rect.setAttribute('width', innerW);
    rect.setAttribute('height', yScale(b.hi) - yScale(b.lo));
    rect.setAttribute('fill', b.fill);
    rect.setAttribute('opacity', b.op);
    svg.appendChild(rect);
  }

  /* gridlines & labels */
  for (const hz of xFreqs) {
    const x = xScale(hz);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', x); line.setAttribute('x2', x);
    line.setAttribute('y1', M.t); line.setAttribute('y2', M.t + innerH);
    line.setAttribute('stroke', '#2c2a22');
    line.setAttribute('stroke-width', '0.4');
    line.setAttribute('opacity', '0.45');
    svg.appendChild(line);

    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', x);
    label.setAttribute('y', H - M.b + 22);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-family', 'JetBrains Mono, monospace');
    label.setAttribute('font-size', '11');
    label.setAttribute('fill', '#3a372d');
    label.textContent = hz >= 1000 ? (hz/1000) + 'k' : hz;
    svg.appendChild(label);
  }
  for (let db = yMin; db <= yMax; db += 10) {
    const y = yScale(db);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', M.l); line.setAttribute('x2', M.l + innerW);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('stroke', '#2c2a22');
    line.setAttribute('stroke-width', db === 0 ? '0.9' : '0.3');
    line.setAttribute('opacity', db === 0 ? '0.7' : '0.32');
    svg.appendChild(line);

    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', M.l - 12);
    label.setAttribute('y', y + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('font-family', 'JetBrains Mono, monospace');
    label.setAttribute('font-size', '11');
    label.setAttribute('fill', '#3a372d');
    label.textContent = db;
    svg.appendChild(label);
  }

  /* axis titles */
  const xt = document.createElementNS(ns, 'text');
  xt.setAttribute('x', M.l + innerW / 2);
  xt.setAttribute('y', H - 12);
  xt.setAttribute('text-anchor', 'middle');
  xt.setAttribute('font-family', 'JetBrains Mono, monospace');
  xt.setAttribute('font-size', '10');
  xt.setAttribute('letter-spacing', '0.18em');
  xt.setAttribute('fill', '#8a836f');
  xt.textContent = 'FREQUENCY · Hz';
  svg.appendChild(xt);

  const yt = document.createElementNS(ns, 'text');
  yt.setAttribute('x', 14);
  yt.setAttribute('y', M.t + innerH / 2);
  yt.setAttribute('text-anchor', 'middle');
  yt.setAttribute('font-family', 'JetBrains Mono, monospace');
  yt.setAttribute('font-size', '10');
  yt.setAttribute('letter-spacing', '0.18em');
  yt.setAttribute('fill', '#8a836f');
  yt.setAttribute('transform', `rotate(-90, 14, ${M.t + innerH/2})`);
  yt.textContent = 'HEARING LEVEL · dB HL';
  svg.appendChild(yt);

  /* plot points and lines per ear */
  const plotEar = (ear, color, symbol) => {
    const r = session.results[ear];
    const pts = [];
    for (const f of session.freqs) {
      if (r[f] == null) continue;
      pts.push({ x: xScale(f), y: yScale(r[f]), f, db: r[f] });
    }
    /* connecting line */
    if (pts.length > 1) {
      const path = document.createElementNS(ns, 'path');
      const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p.x + ',' + p.y).join(' ');
      path.setAttribute('d', d);
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', '1.4');
      path.setAttribute('fill', 'none');
      path.setAttribute('opacity', '0.85');
      svg.appendChild(path);
    }
    /* symbols */
    for (const p of pts) {
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('transform', `translate(${p.x}, ${p.y})`);
      if (symbol === 'O') {
        const c = document.createElementNS(ns, 'circle');
        c.setAttribute('r', 7);
        c.setAttribute('fill', 'none');
        c.setAttribute('stroke', color);
        c.setAttribute('stroke-width', 1.8);
        g.appendChild(c);
      } else {
        for (const angle of [45, -45]) {
          const l = document.createElementNS(ns, 'line');
          const r = 7;
          const a = angle * Math.PI / 180;
          l.setAttribute('x1', -r * Math.cos(a));
          l.setAttribute('x2',  r * Math.cos(a));
          l.setAttribute('y1', -r * Math.sin(a));
          l.setAttribute('y2',  r * Math.sin(a));
          l.setAttribute('stroke', color);
          l.setAttribute('stroke-width', 1.8);
          g.appendChild(l);
        }
      }
      svg.appendChild(g);
    }
  };

  plotEar('right', '#b9302a', 'O');
  plotEar('left',  '#1c3666', 'X');
}

/* ---------- Trend chart ---------- */
function drawTrend(svg, history, opts = {}) {
  const W = 1000, H = opts.height || 180;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = '';
  const ns = 'http://www.w3.org/2000/svg';

  if (!history.length) {
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', W/2); t.setAttribute('y', H/2);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-family', 'Fraunces, serif');
    t.setAttribute('font-style', 'italic');
    t.setAttribute('font-size', '18');
    t.setAttribute('fill', '#8a836f');
    t.textContent = 'No data yet.';
    svg.appendChild(t);
    return;
  }

  const M = { l: 50, r: 30, t: 24, b: 36 };
  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;

  /* x: time, y: PTA */
  const data = history.slice(-12);
  const t0 = data[0].ts, t1 = data[data.length - 1].ts;
  const tSpan = Math.max(1, t1 - t0);
  const xScale = (ts) => data.length === 1 ? M.l + innerW/2 : M.l + (ts - t0) / tSpan * innerW;

  const yMin = 0, yMax = 60;
  const yScale = (db) => M.t + (db - yMin) / (yMax - yMin) * innerH;

  /* gridlines */
  for (let db = 0; db <= 60; db += 20) {
    const y = yScale(db);
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', M.l); l.setAttribute('x2', M.l + innerW);
    l.setAttribute('y1', y);   l.setAttribute('y2', y);
    l.setAttribute('stroke', '#2c2a22');
    l.setAttribute('stroke-width', '0.3');
    l.setAttribute('opacity', '0.3');
    svg.appendChild(l);

    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', M.l - 8);
    label.setAttribute('y', y + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('font-family', 'JetBrains Mono, monospace');
    label.setAttribute('font-size', '10');
    label.setAttribute('fill', '#8a836f');
    label.textContent = db;
    svg.appendChild(label);
  }

  /* lines per ear */
  const plotLine = (ear, color, sym) => {
    const pts = data.map(s => {
      const pta = computePTA(s.results[ear]);
      return pta == null ? null : { x: xScale(s.ts), y: yScale(pta), pta, ts: s.ts };
    }).filter(Boolean);
    if (pts.length === 0) return;
    if (pts.length > 1) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', pts.map((p,i) => (i===0?'M':'L')+p.x+','+p.y).join(' '));
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', 1.6);
      path.setAttribute('fill', 'none');
      svg.appendChild(path);
    }
    for (const p of pts) {
      if (sym === 'O') {
        const c = document.createElementNS(ns, 'circle');
        c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', 4);
        c.setAttribute('fill', '#f3ede1'); c.setAttribute('stroke', color); c.setAttribute('stroke-width', 1.5);
        svg.appendChild(c);
      } else {
        const g = document.createElementNS(ns, 'g');
        g.setAttribute('transform', `translate(${p.x},${p.y})`);
        for (const ang of [45,-45]) {
          const a = ang * Math.PI/180, r = 5;
          const l = document.createElementNS(ns, 'line');
          l.setAttribute('x1', -r*Math.cos(a)); l.setAttribute('x2', r*Math.cos(a));
          l.setAttribute('y1', -r*Math.sin(a)); l.setAttribute('y2', r*Math.sin(a));
          l.setAttribute('stroke', color); l.setAttribute('stroke-width', 1.6);
          g.appendChild(l);
        }
        svg.appendChild(g);
      }
    }
  };
  plotLine('right', '#b9302a', 'O');
  plotLine('left',  '#1c3666', 'X');

  /* date ticks */
  for (let i = 0; i < data.length; i++) {
    const s = data[i];
    if (data.length > 6 && i % 2) continue;
    const x = xScale(s.ts);
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', x); t.setAttribute('y', H - 12);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-family', 'JetBrains Mono, monospace');
    t.setAttribute('font-size', '9');
    t.setAttribute('fill', '#8a836f');
    const d = new Date(s.ts);
    t.textContent = `${d.getMonth()+1}/${d.getDate()}`;
    svg.appendChild(t);
  }
}

/* ---------- Per-frequency detailed trend ---------- */
function drawDetailedTrend(svg, history) {
  const W = 1000, H = 320;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = '';
  const ns = 'http://www.w3.org/2000/svg';

  if (history.length < 2) {
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', W/2); t.setAttribute('y', H/2);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-family', 'Fraunces, serif');
    t.setAttribute('font-style', 'italic');
    t.setAttribute('font-size', '18');
    t.setAttribute('fill', '#8a836f');
    t.textContent = 'At least two assessments are needed for a per-frequency trend.';
    svg.appendChild(t);
    return;
  }

  const M = { l: 60, r: 30, t: 30, b: 50 };
  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;

  const data = history.slice(-12);
  const xMin = data[0].ts, xMax = data[data.length-1].ts;
  const xSpan = Math.max(1, xMax - xMin);
  const xScale = ts => M.l + (ts - xMin) / xSpan * innerW;

  const yMin = 0, yMax = 80;
  const yScale = db => M.t + (db - yMin) / (yMax - yMin) * innerH;

  /* y grid */
  for (let db = 0; db <= 80; db += 20) {
    const y = yScale(db);
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', M.l); l.setAttribute('x2', M.l + innerW);
    l.setAttribute('y1', y); l.setAttribute('y2', y);
    l.setAttribute('stroke', '#2c2a22'); l.setAttribute('opacity', '0.2');
    svg.appendChild(l);
    const lab = document.createElementNS(ns, 'text');
    lab.setAttribute('x', M.l - 8); lab.setAttribute('y', y + 4);
    lab.setAttribute('text-anchor', 'end');
    lab.setAttribute('font-family', 'JetBrains Mono, monospace');
    lab.setAttribute('font-size', '10'); lab.setAttribute('fill', '#8a836f');
    lab.textContent = db + ' dB';
    svg.appendChild(lab);
  }

  const palette = ['#1c3666', '#345da8', '#5a89c7', '#a48d2b', '#c87b1f', '#b9302a', '#7d2823', '#3a372d'];

  for (let fi = 0; fi < FREQS_FULL.length; fi++) {
    const f = FREQS_FULL[fi];
    const color = palette[fi % palette.length];
    const pts = data.map(s => {
      const r = s.results.right?.[f];
      const l = s.results.left?.[f];
      const avg = (r != null && l != null) ? (r+l)/2 : (r ?? l);
      return avg == null ? null : { x: xScale(s.ts), y: yScale(avg) };
    }).filter(Boolean);
    if (pts.length < 2) continue;

    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', pts.map((p,i) => (i===0?'M':'L')+p.x+','+p.y).join(' '));
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', 1.4);
    path.setAttribute('fill', 'none');
    path.setAttribute('opacity', '0.85');
    svg.appendChild(path);

    const last = pts[pts.length-1];
    const lab = document.createElementNS(ns, 'text');
    lab.setAttribute('x', last.x + 6); lab.setAttribute('y', last.y + 4);
    lab.setAttribute('font-family', 'JetBrains Mono, monospace');
    lab.setAttribute('font-size', '10'); lab.setAttribute('fill', color);
    lab.textContent = f >= 1000 ? (f/1000)+'k' : f;
    svg.appendChild(lab);
  }
}

/* ---------- Render history ---------- */
function renderHistory() {
  const tb = $('#history-tbody');
  tb.innerHTML = '';
  const items = [...state.history].sort((a,b) => b.ts - a.ts);
  $('#history-count').textContent = items.length + ' assessment' + (items.length === 1 ? '' : 's');
  if (items.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="7" style="padding:32px 8px;font-family:Fraunces,serif;font-style:italic;color:#8a836f;text-align:center">No assessments recorded yet.</td>`;
    tb.appendChild(tr);
  } else {
    for (const s of items) {
      const ptaR = computePTA(s.results.right);
      const ptaL = computePTA(s.results.left);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${fmtDate(s.ts)}</td>
        <td class="mono dim">${s.mode}</td>
        <td>${ptaR != null ? ptaR + ' dB' : '—'}</td>
        <td>${ptaL != null ? ptaL + ' dB' : '—'}</td>
        <td><span class="mono">${classifyPTA(ptaR).label}</span></td>
        <td><span class="mono">${classifyPTA(ptaL).label}</span></td>
        <td><button class="delete-btn mono" data-del="${s.id}">delete</button></td>
      `;
      tr.addEventListener('click', (e) => {
        if (e.target.dataset.del) return;
        showResults(s);
      });
      tb.appendChild(tr);
    }
  }
  drawDetailedTrend($('#trend-detailed'), state.history);
  drawTrend($('#trend-chart'), state.history);
}

/* ---------- Tinnitus matcher ---------- */
const Tinnitus = {
  state: {
    type: 'sine',
    freq: 6000,
    level: -30,
    side: 'both',
    handle: null,
  },

  init() {
    const s = this.state;

    $('#tin-freq').addEventListener('input', e => {
      s.freq = +e.target.value;
      $('#tin-freq-readout').textContent = fmtHz(s.freq);
      if (s.handle) s.handle.setFrequency(s.freq);
    });
    $('#tin-level').addEventListener('input', e => {
      s.level = +e.target.value;
      $('#tin-level-readout').textContent = `${s.level} dB`;
      if (s.handle) s.handle.setLevel(s.level);
    });
    $$('[data-tin-type]').forEach(b => b.addEventListener('click', () => {
      $$('[data-tin-type]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      s.type = b.dataset.tinType;
      if (s.handle) {
        s.handle.stop();
        s.handle = Audio.startContinuous({ freq: s.freq, level: s.level, ear: s.side, type: s.type });
      }
    }));
    $$('[data-tin-side]').forEach(b => b.addEventListener('click', () => {
      $$('[data-tin-side]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      s.side = b.dataset.tinSide;
      if (s.handle) s.handle.setEar(s.side);
    }));

    $('#tin-play').addEventListener('click', async () => {
      await Audio.resume();
      if (s.handle) {
        s.handle.stop();
        s.handle = null;
        $('#tin-play').textContent = '▶ Play';
      } else {
        s.handle = Audio.startContinuous({ freq: s.freq, level: s.level, ear: s.side, type: s.type });
        $('#tin-play').textContent = '■ Stop';
      }
    });
    $('#tin-save').addEventListener('click', () => {
      state.tinnitusMatches.push({
        ts: Date.now(), freq: s.freq, level: s.level, type: s.type, side: s.side,
      });
      Storage.save();
      this.renderMatches();
      toast('Match saved');
    });

    this.renderMatches();
    /* set initial readouts */
    $('#tin-freq-readout').textContent = fmtHz(s.freq);
    $('#tin-level-readout').textContent = `${s.level} dB`;
  },

  renderMatches() {
    const ul = $('#tin-matches');
    ul.innerHTML = '';
    if (state.tinnitusMatches.length === 0) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="empty">No matches saved yet.</span>';
      ul.appendChild(li);
      return;
    }
    const items = [...state.tinnitusMatches].sort((a,b) => b.ts - a.ts);
    for (const m of items) {
      const li = document.createElement('li');
      li.innerHTML = `
        <span>${fmtDate(m.ts)} · ${m.type} · ${m.side}</span>
        <span>${fmtHz(m.freq)}</span>
        <span>${m.level} dB</span>
        <span class="delete" data-del-tin="${m.ts}">remove</span>
      `;
      ul.appendChild(li);
    }
  },

  stopAll() {
    if (this.state.handle) {
      this.state.handle.stop();
      this.state.handle = null;
      const btn = $('#tin-play');
      if (btn) btn.textContent = '▶ Play';
    }
  },
};

/* ---------- Noise meter ---------- */
const NoiseMeter = {
  running: false,
  ctx: null,
  source: null,
  analyser: null,
  hp: null, lp: null,
  rafId: null,
  startTs: 0,
  peak: -Infinity,
  sumPow: 0,
  nSamples: 0,
  /* Calibration offset: dBFS_to_dBSPL.
     Without a calibrated reference mic this is approximate;
     typical built-in mics: 0 dBFS ≈ 100 dB SPL. */
  offset: 100,

  async toggle() {
    if (this.running) { this.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.source = this.ctx.createMediaStreamSource(stream);

      /* approximate A-weighting via HPF + LPF */
      this.hp = this.ctx.createBiquadFilter();
      this.hp.type = 'highpass';
      this.hp.frequency.value = 100;
      this.hp.Q.value = 0.7;
      this.lp = this.ctx.createBiquadFilter();
      this.lp.type = 'lowpass';
      this.lp.frequency.value = 12000;
      this.lp.Q.value = 0.7;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;

      this.source.connect(this.hp);
      this.hp.connect(this.lp);
      this.lp.connect(this.analyser);

      this.running = true;
      this.startTs = Date.now();
      this.peak = -Infinity;
      this.sumPow = 0;
      this.nSamples = 0;
      $('#meter-toggle').textContent = '■ Stop';
      $('#audio-status').classList.add('armed');
      this.loop();
    } catch (err) {
      toast('Microphone permission required');
    }
  },

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    if (this.source) {
      try { this.source.mediaStream.getTracks().forEach(t => t.stop()); } catch (e) {}
    }
    if (this.ctx) try { this.ctx.close(); } catch (e) {}
    this.ctx = this.source = this.analyser = null;
    $('#meter-toggle').textContent = 'Start measuring';
    $('#audio-status').classList.remove('armed');
  },

  reset() {
    this.peak = -Infinity;
    this.sumPow = 0;
    this.nSamples = 0;
    this.startTs = Date.now();
    $('#meter-peak').textContent = '—';
    $('#meter-leq').textContent = '—';
    $('#meter-dur').textContent = '00:00';
    $('#meter-dose').textContent = '0%';
  },

  loop() {
    if (!this.running) return;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);

    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const dbFS = 20 * Math.log10(Math.max(1e-9, rms));
    const dbSPL = dbFS + this.offset;

    /* Update */
    $('#meter-value').textContent = isFinite(dbSPL) ? Math.round(dbSPL) : '—';
    const pct = Math.max(0, Math.min(100, (dbSPL - 30) / 90 * 100));
    $('#meter-bar-fill').style.width = pct + '%';

    if (dbSPL > this.peak) this.peak = dbSPL;
    this.sumPow += rms * rms;
    this.nSamples++;
    const leqDbFS = 10 * Math.log10(this.sumPow / this.nSamples);
    const leq = leqDbFS + this.offset;

    const elapsed = (Date.now() - this.startTs) / 1000;
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(Math.floor(elapsed % 60)).padStart(2, '0');
    $('#meter-peak').textContent = Math.round(this.peak) + ' dB';
    $('#meter-leq').textContent  = Math.round(leq) + ' dB';
    $('#meter-dur').textContent  = `${mm}:${ss}`;

    /* NIOSH dose: 100% = 85 dBA × 8h, 3-dB exchange */
    const allowedSec = 28800 * Math.pow(2, -(leq - 85) / 3);
    const dose = elapsed / allowedSec * 100;
    $('#meter-dose').textContent = isFinite(dose) ? Math.round(Math.min(999, dose)) + '%' : '—';

    this.rafId = requestAnimationFrame(() => this.loop());
  },
};

/* ---------- Calibration view logic ---------- */
const Calibrate = {
  init() {
    $('[data-cal="play-left"]').addEventListener('click', async () => {
      await Audio.resume();
      Audio.playTone({ freq: 1000, dbHL: 60, durationMs: 700, ear: 'left' });
    });
    $('[data-cal="play-right"]').addEventListener('click', async () => {
      await Audio.resume();
      Audio.playTone({ freq: 1000, dbHL: 60, durationMs: 700, ear: 'right' });
    });
    $('[data-cal="play-reference"]').addEventListener('click', async () => {
      await Audio.resume();
      Audio.startPulsedReference();
    });
    $('[data-cal="stop-reference"]').addEventListener('click', () => Audio.stopPulsedReference());

    $('#cal-trim').addEventListener('input', e => {
      $('#cal-trim-readout').textContent = (+e.target.value).toFixed(1) + ' dB';
    });

    $('[data-cal="measure-noise"]').addEventListener('click', () => this.measureNoise());

    $('[data-cal="save"]').addEventListener('click', () => {
      Audio.stopPulsedReference();
      const trim = +$('#cal-trim').value;
      state.cal = {
        gain: REFERENCE_GAIN,
        trim,
        ts: Date.now(),
        channelsConfirmed: $('#cal-channels-confirm').checked,
      };
      Storage.save();
      toast('Calibration saved');
      Router.go('home');
    });
  },

  async measureNoise() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const ana = ctx.createAnalyser();
      ana.fftSize = 2048;
      src.connect(ana);

      const buf = new Float32Array(ana.fftSize);
      let max = -Infinity, sum = 0, n = 0;
      const start = Date.now();
      $('#cal-noise-readout').textContent = 'measuring…';

      const tick = () => {
        ana.getFloatTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i]*buf[i];
        const rms = Math.sqrt(s / buf.length);
        const db = 20 * Math.log10(Math.max(1e-9, rms)) + 100;
        if (db > max) max = db;
        sum += rms*rms; n++;
        if (Date.now() - start < 3000) requestAnimationFrame(tick);
        else {
          stream.getTracks().forEach(t => t.stop());
          ctx.close();
          const leq = 10 * Math.log10(sum / n) + 100;
          const peakStr = Math.round(max) + ' dB peak';
          const leqStr  = Math.round(leq) + ' dB avg';
          let verdict = '';
          if (leq < 35) verdict = '— excellent';
          else if (leq < 45) verdict = '— acceptable';
          else verdict = '— too noisy, find a quieter room';
          $('#cal-noise-readout').textContent = `${leqStr} · ${peakStr} ${verdict}`;
        }
      };
      tick();
    } catch (err) {
      $('#cal-noise-readout').textContent = 'microphone permission required';
    }
  },
};

/* ---------- Home / dashboard rendering ---------- */
function renderHome() {
  const last = state.history.length ? state.history[state.history.length-1] : null;
  if (last) {
    const ptaR = computePTA(last.results.right);
    const ptaL = computePTA(last.results.left);
    const clsR = classifyPTA(ptaR);
    const clsL = classifyPTA(ptaL);
    $('#latest-date').textContent = fmtDateTime(last.ts);
    $('#latest-summary').innerHTML = `
      <div class="summary-stat">
        <span class="label">PTA · Right</span>
        <span class="value right">${ptaR ?? '—'}<span style="font-size:18px;color:var(--ink-faint);"> dB</span></span>
        <span class="sub">${clsR.label}</span>
      </div>
      <div class="summary-stat">
        <span class="label">PTA · Left</span>
        <span class="value left">${ptaL ?? '—'}<span style="font-size:18px;color:var(--ink-faint);"> dB</span></span>
        <span class="sub">${clsL.label}</span>
      </div>
      <div class="summary-stat">
        <span class="label">Mode</span>
        <span class="value" style="font-size:28px;">${last.mode}</span>
        <span class="sub">${last.freqs.length} frequencies × 2 ears</span>
      </div>
    `;
  } else {
    $('#latest-date').textContent = '—';
    $('#latest-summary').innerHTML = `
      <div class="summary-empty">
        <p class="serif-italic" style="font-size:22px;color:var(--ink-soft);">No assessments yet.</p>
        <p class="dim">Your audiograms and trends will appear here once you complete your first test.</p>
      </div>
    `;
  }

  drawTrend($('#trend-chart'), state.history);

  /* rotating tip */
  const tips = [
    'Sustained exposure above 85 dBA accumulates damage — eight hours at that level reaches the daily noise dose.',
    'Hearing loss is rarely reversible, but it is almost always slowable. The single biggest lever is sound exposure.',
    'High-frequency loss often appears first, around 4 kHz, and is the classic signature of noise damage.',
    'Tinnitus and hearing loss are linked. If a ringing arrives, get a baseline test before it normalises.',
    'A quiet room is non-negotiable for accurate threshold measurement. Aim for ambient noise below 35 dB.',
    'Earbuds at 50% volume in the subway reach the same SPL as a chainsaw. Headphones with passive isolation reduce the temptation.',
    'The 60/60 rule — never above 60% volume, never longer than 60 minutes without a break.',
  ];
  $('#tip-text').textContent = tips[Math.floor(Math.random() * tips.length)];
}

/* ---------- View enter ---------- */
function onViewEnter(view) {
  if (view === 'home')      renderHome();
  if (view === 'history')   renderHistory();
  if (view === 'tinnitus')  Tinnitus.renderMatches();
  if (view === 'results')   { /* renderHistory drawing already; results filled by showResults */ }

  /* clean-ups across nav */
  if (view !== 'tinnitus') Tinnitus.stopAll();
  if (view !== 'noise')    NoiseMeter.stop();
  if (view !== 'calibrate') Audio.stopPulsedReference();
}

/* ---------- Wire-up ---------- */
function wire() {
  /* hero / quick actions */
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    if (a === 'start-assessment' || a === 'full-test') Test.run({ mode: 'full' });
    else if (a === 'quick-test') Test.run({ mode: 'quick' });
    else if (a === 'calibrate')  Router.go('calibrate');
    else if (a === 'reminder')   askReminder();
  });

  /* expose calibrate for modal */
  window.__app = window.__app || {};
  window.__app.calibrate = () => { modal.close(); Router.go('calibrate'); };

  /* gate button */
  $('#btn-gate-start').addEventListener('click', async () => {
    await Audio.resume();
    if (!state.test) await Test.run({ mode: 'full' });
    $('#test-gate').style.display = 'none';
    $('#test-stage').classList.add('active');
    Test.begin();
  });
  $('#btn-hear').addEventListener('click', () => Test.reportResponse());
  $('#btn-pause').addEventListener('click', () => Test.pause());
  $('#btn-skip').addEventListener('click', () => Test.skip());
  $('#btn-abort').addEventListener('click', () => {
    if (confirm('End the test? Partial results will not be saved.')) Test.abort();
  });

  /* keyboard: SPACE = response during test */
  document.addEventListener('keydown', (e) => {
    if (state.view === 'test' && e.code === 'Space' && state.test) {
      e.preventDefault();
      Test.reportResponse();
    }
    if (e.code === 'Escape' && !$('#modal').hidden) modal.close();
  });

  /* modal close */
  document.addEventListener('click', e => {
    if (e.target.matches('[data-modal-close]')) modal.close();
  });

  /* results actions */
  $('#btn-export-pdf').addEventListener('click', () => window.print());
  $('#btn-export-json').addEventListener('click', () => exportJSON([state.history[state.history.length-1]]));
  $('#btn-share').addEventListener('click', () => copySummary(state.history[state.history.length-1]));
  $('#btn-retest').addEventListener('click', () => Test.run({ mode: state.history[state.history.length-1]?.mode || 'full' }));

  /* history */
  $('#btn-export-all').addEventListener('click', () => exportJSON(state.history));
  $('#btn-clear').addEventListener('click', () => {
    if (confirm('Clear all history? This cannot be undone.')) {
      state.history = [];
      Storage.save();
      renderHistory();
      renderHome();
      toast('History cleared');
    }
  });
  document.addEventListener('click', e => {
    if (e.target.matches('[data-del]')) {
      const id = e.target.dataset.del;
      state.history = state.history.filter(s => s.id !== id);
      Storage.save();
      renderHistory();
      renderHome();
    }
    if (e.target.matches('[data-del-tin]')) {
      const ts = +e.target.dataset.delTin;
      state.tinnitusMatches = state.tinnitusMatches.filter(m => m.ts !== ts);
      Storage.save();
      Tinnitus.renderMatches();
    }
  });

  /* tinnitus */
  Tinnitus.init();

  /* calibration */
  Calibrate.init();

  /* noise meter */
  $('#meter-toggle').addEventListener('click', () => NoiseMeter.toggle());
  $('#meter-reset').addEventListener('click', () => NoiseMeter.reset());

  /* leave-page guards */
  window.addEventListener('beforeunload', () => {
    Tinnitus.stopAll();
    NoiseMeter.stop();
    Audio.stopPulsedReference();
  });
}

/* ---------- Reminders ---------- */
function askReminder() {
  modal.open(`
    <h3>Schedule a retest reminder</h3>
    <p>Pick how often you want to be reminded. We will use your browser's built-in Notification API — no server, no account.</p>
    <div style="display:grid;gap:10px;margin:16px 0;">
      <button class="btn btn-secondary" data-rem="30">Every 30 days</button>
      <button class="btn btn-secondary" data-rem="90">Every 90 days</button>
      <button class="btn btn-secondary" data-rem="180">Every 6 months</button>
      <button class="btn btn-secondary" data-rem="365">Once a year</button>
    </div>
  `);
  document.querySelectorAll('[data-rem]').forEach(b => b.addEventListener('click', async () => {
    const days = +b.dataset.rem;
    if ('Notification' in window) {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        const next = Date.now() + days * 86400000;
        localStorage.setItem('audiometry.reminder', String(next));
        toast(`Reminder set for ${fmtDate(next)}`);
        modal.close();
      } else {
        toast('Notifications not granted — set a calendar reminder instead');
      }
    } else {
      toast('Notifications unsupported in this browser');
    }
  }));
}

function checkReminderDue() {
  const due = +localStorage.getItem('audiometry.reminder') || 0;
  if (due && Date.now() >= due) {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Audiometry retest', { body: 'Time for a new hearing assessment.' });
    }
    localStorage.removeItem('audiometry.reminder');
  }
}

/* ---------- Export / share ---------- */
function exportJSON(items) {
  const data = JSON.stringify({ exportedAt: new Date().toISOString(), sessions: items }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audiometry-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
function copySummary(session) {
  if (!session) return toast('No session to copy');
  const ptaR = computePTA(session.results.right);
  const ptaL = computePTA(session.results.left);
  const lines = [
    `Audiometry — ${fmtDateTime(session.ts)}`,
    `Mode: ${session.mode}`,
    `PTA Right: ${ptaR ?? '—'} dB HL  (${classifyPTA(ptaR).label})`,
    `PTA Left:  ${ptaL ?? '—'} dB HL  (${classifyPTA(ptaL).label})`,
    '',
    'Right ear thresholds (dB HL):',
    ...session.freqs.map(f => `  ${String(f).padStart(5)} Hz : ${session.results.right[f] ?? '—'}`),
    '',
    'Left ear thresholds (dB HL):',
    ...session.freqs.map(f => `  ${String(f).padStart(5)} Hz : ${session.results.left[f] ?? '—'}`),
    '',
    '— Screening tool, not a diagnosis.',
  ].join('\n');
  navigator.clipboard.writeText(lines).then(() => toast('Summary copied'));
}

/* ---------- Boot ---------- */
function boot() {
  Storage.load();
  wire();
  Router.init();
  checkReminderDue();
}

document.addEventListener('DOMContentLoaded', boot);

/* expose for debugging */
window.__audiometry = { state, Storage, Test, Audio, NoiseMeter };

})();
