'use strict';

// ── Note bank: A#2 (116.54 Hz) to C5 (523.25 Hz), semitone steps ─────────────
const ALL_NOTES = [
  { name: 'A#2', freq: 116.54 },
  { name: 'B2',  freq: 123.47 },
  { name: 'C3',  freq: 130.81 },
  { name: 'C#3', freq: 138.59 },
  { name: 'D3',  freq: 146.83 },
  { name: 'D#3', freq: 155.56 },
  { name: 'E3',  freq: 164.81 },
  { name: 'F3',  freq: 174.61 },
  { name: 'F#3', freq: 185.00 },
  { name: 'G3',  freq: 196.00 },
  { name: 'G#3', freq: 207.65 },
  { name: 'A3',  freq: 220.00 },
  { name: 'A#3', freq: 233.08 },
  { name: 'B3',  freq: 246.94 },
  { name: 'C4',  freq: 261.63 },
  { name: 'C#4', freq: 277.18 },
  { name: 'D4',  freq: 293.66 },
  { name: 'D#4', freq: 311.13 },
  { name: 'E4',  freq: 329.63 },
  { name: 'F4',  freq: 349.23 },
  { name: 'F#4', freq: 369.99 },
  { name: 'G4',  freq: 392.00 },
  { name: 'G#4', freq: 415.30 },
  { name: 'A4',  freq: 440.00 },
  { name: 'A#4', freq: 466.16 },
  { name: 'B4',  freq: 493.88 },
  { name: 'C5',  freq: 523.25 },
];

// Easy mode: C3 through C4 (indices 2–14 inclusive)
const EASY_NOTES = ALL_NOTES.slice(2, 15);

// ── App state ─────────────────────────────────────────────────────────────────
let audioCtx     = null;   // lazy-created on first user gesture
let targetNote   = null;   // current challenge note
let micStream    = null;   // MediaStream from getUserMedia
let animFrameId  = null;   // rAF handle for pitch-detection loop
let validSamples = [];     // frequencies collected during listening
let currentMode  = 'easy';
let stats        = { attempts: 0, hits: 0 };
let history      = [];     // [{ cents, note }] last ≤10 attempts

// ── DOM references ────────────────────────────────────────────────────────────
const noteNameEl    = document.getElementById('noteName');
const noteHintEl    = document.getElementById('noteHint');
const meterEl       = document.getElementById('meterContainer');
const needleEl      = document.getElementById('needle');
const resultEl      = document.getElementById('result');
const attemptsEl    = document.getElementById('attempts');
const hitsEl        = document.getElementById('hits');
const rateEl        = document.getElementById('rate');
const playBtn       = document.getElementById('playBtn');
const singBtn       = document.getElementById('singBtn');
const resetBtn      = document.getElementById('resetBtn');
const easyBtn       = document.getElementById('easyBtn');
const fullBtn       = document.getElementById('fullBtn');
const historyCanvas = document.getElementById('historyChart');

// ── Persistence ───────────────────────────────────────────────────────────────
function loadStats() {
  try {
    const raw = localStorage.getItem('pitchTrainerStats');
    if (raw) {
      const parsed = JSON.parse(raw);
      stats   = parsed.stats   || { attempts: 0, hits: 0 };
      history = parsed.history || [];
    }
  } catch (_) { /* ignore corrupt storage */ }
  updateStatsUI();
  drawHistory();
}

function saveStats() {
  try {
    localStorage.setItem('pitchTrainerStats', JSON.stringify({ stats, history }));
  } catch (_) {}
}

function updateStatsUI() {
  attemptsEl.textContent = stats.attempts;
  hitsEl.textContent     = stats.hits;
  const rate = stats.attempts > 0 ? Math.round((stats.hits / stats.attempts) * 100) : 0;
  rateEl.textContent     = rate + '%';
}

// ── History chart (canvas) ────────────────────────────────────────────────────
function drawHistory() {
  const canvas = historyCanvas;
  const dpr    = window.devicePixelRatio || 1;
  const cssW   = canvas.clientWidth  || canvas.offsetWidth  || 380;
  const cssH   = 80;

  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  if (history.length === 0) {
    ctx.fillStyle = '#555';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('まだ挑戦していません', cssW / 2, cssH / 2);
    return;
  }

  const n      = history.length;
  const gap    = 4;
  const barW   = Math.floor((cssW - gap * (n - 1)) / n);
  const midY   = cssH / 2;
  const maxC   = 100; // cents range to display

  // Center baseline
  ctx.strokeStyle = '#2e2e46';
  ctx.lineWidth   = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(cssW, midY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Good-zone band (±25¢)
  const zoneH = (25 / maxC) * (cssH / 2);
  ctx.fillStyle = 'rgba(78,204,163,0.07)';
  ctx.fillRect(0, midY - zoneH, cssW, zoneH * 2);

  history.forEach((entry, i) => {
    const x         = i * (barW + gap);
    const clampedC  = Math.max(-maxC, Math.min(maxC, entry.cents));
    const barH      = Math.abs(clampedC) / maxC * (midY - 2);

    const absC = Math.abs(entry.cents);
    let color;
    if (absC <= 25)       color = '#4ecca3';
    else if (absC <= 60)  color = '#f5c518';
    else                  color = '#ff6b6b';

    ctx.fillStyle = color;
    ctx.beginPath();
    const radius = Math.min(3, barW / 2);
    if (entry.cents >= 0) {
      roundedRect(ctx, x, midY - barH, barW, barH, radius);
    } else {
      roundedRect(ctx, x, midY, barW, barH, radius);
    }
    ctx.fill();
  });
}

function roundedRect(ctx, x, y, w, h, r) {
  if (h < r * 2) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Pitch detection — autocorrelation (McLeod / Chris Wilson variant) ─────────
//
// Works by computing the autocorrelation function of the audio buffer,
// finding the first post-zero-lag peak (= fundamental period lag), then
// converting lag → Hz via sampleRate / lag.
//
function autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length;

  // 1. RMS energy gate — skip silent frames
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return null;

  // 2. Compute autocorrelation only up to the longest possible vocal period.
  //    60 Hz is the lowest pitch we accept; maxLag caps the inner loop.
  const maxLag = Math.min(SIZE - 1, Math.ceil(sampleRate / 60));

  const c = new Float32Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let sum = 0;
    const limit = SIZE - lag;
    for (let j = 0; j < limit; j++) {
      sum += buf[j] * buf[j + lag];
    }
    c[lag] = sum;
  }

  // 3. Skip the zero-lag peak: walk until we hit the first local minimum.
  let d = 0;
  while (d < maxLag && c[d] > c[d + 1]) d++;

  // 4. Find the global maximum of c[] after that dip.
  let maxVal = -Infinity, bestLag = -1;
  for (let i = d; i <= maxLag; i++) {
    if (c[i] > maxVal) { maxVal = c[i]; bestLag = i; }
  }

  if (bestLag <= 0) return null;

  // 5. Confidence: peak must be ≥50% of zero-lag energy (how periodic the signal is).
  if (c[0] > 0 && maxVal / c[0] < 0.5) return null;

  // 6. Parabolic interpolation for sub-sample lag accuracy.
  let T0 = bestLag;
  if (bestLag > 0 && bestLag < maxLag) {
    const x1 = c[bestLag - 1], x2 = c[bestLag], x3 = c[bestLag + 1];
    const a  = (x1 + x3 - 2 * x2) / 2;
    const b  = (x3 - x1) / 2;
    if (a !== 0) T0 = bestLag - b / (2 * a);
  }

  const freq = sampleRate / T0;

  // 7. Sanity-check: must fall within a realistic vocal range.
  return (freq >= 60 && freq <= 800) ? freq : null;
}

// ── Meter helpers ─────────────────────────────────────────────────────────────
function showMeter() {
  meterEl.classList.add('visible');
  meterEl.removeAttribute('aria-hidden');
}
function hideMeter() {
  meterEl.classList.remove('visible');
  meterEl.setAttribute('aria-hidden', 'true');
  setNeedle(0);
}

// cents: 0 = center; ±75 = full left/right
function setNeedle(cents) {
  const clamped = Math.max(-75, Math.min(75, cents));
  const pct     = (clamped / 150 + 0.5) * 100; // map [-75,75] → [0%,100%]
  needleEl.style.left = pct + '%';

  // Color the needle based on deviation
  const absC = Math.abs(clamped);
  if (absC <= 25)      needleEl.style.background = '#4ecca3';
  else if (absC <= 60) needleEl.style.background = '#f5c518';
  else                 needleEl.style.background = '#ff6b6b';
}

function showResult(msg, cls) {
  resultEl.textContent = msg;
  resultEl.className   = 'result ' + (cls || '');
}

// ── Play a reference tone ─────────────────────────────────────────────────────
async function playNote() {
  // AudioContext must be created inside a user gesture
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  // Pick a random note from the active bank
  const bank = currentMode === 'easy' ? EASY_NOTES : ALL_NOTES;
  targetNote = bank[Math.floor(Math.random() * bank.length)];

  // Reset UI
  noteNameEl.textContent = '?';
  noteNameEl.className   = 'note-name playing';
  noteHintEl.textContent = 'よく聴いてください...';
  resultEl.textContent   = '';
  resultEl.className     = 'result';
  hideMeter();
  playBtn.disabled = true;
  singBtn.disabled = true;

  // Build oscillator with soft fade-in and fade-out to avoid clicks
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.type            = 'sine';
  osc.frequency.value = targetNote.freq;

  const now = audioCtx.currentTime;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.5, now + 0.06);  // fade in
  gain.gain.setValueAtTime(0.5, now + 1.4);
  gain.gain.linearRampToValueAtTime(0, now + 1.5);     // fade out

  osc.start(now);
  osc.stop(now + 1.55);

  osc.onended = () => {
    noteNameEl.classList.remove('playing');
    noteHintEl.textContent = '静かにハミングして、それから歌ってください';
    playBtn.disabled = false;
    singBtn.disabled = false;
  };
}

// ── Microphone listening ──────────────────────────────────────────────────────
async function listenForPitch() {
  if (!targetNote) return;

  // Always stop any leftover mic before starting a new session
  stopMic();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation:  false,  // keep the raw signal for pitch detection
        noiseSuppression:  false,
        autoGainControl:   false,
      }
    });
  } catch (err) {
    const isDenied = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError';
    showResult(
      isDenied
        ? 'マイクへのアクセスが拒否されました。ブラウザの設定で許可してから再度お試しください。'
        : 'マイクを開けませんでした：' + err.message,
      'error'
    );
    return;
  }

  micStream = stream;

  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const source   = audioCtx.createMediaStreamSource(micStream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  const buf = new Float32Array(analyser.fftSize);
  validSamples = [];

  // Update UI
  singBtn.disabled = true;
  singBtn.classList.add('listening');
  playBtn.disabled = true;
  noteHintEl.textContent = '聴いています...';
  showMeter();
  setNeedle(0);

  const LISTEN_MS = 3000;
  const t0        = performance.now();

  function tick() {
    analyser.getFloatTimeDomainData(buf);

    const freq = autoCorrelate(buf, audioCtx.sampleRate);
    if (freq !== null) {
      validSamples.push(freq);
      const cents = 1200 * Math.log2(freq / targetNote.freq);
      setNeedle(cents);
    }

    if (performance.now() - t0 < LISTEN_MS) {
      animFrameId = requestAnimationFrame(tick);
    } else {
      finishListening();
    }
  }

  animFrameId = requestAnimationFrame(tick);
}

function stopMic() {
  if (animFrameId  !== null) { cancelAnimationFrame(animFrameId); animFrameId = null; }
  if (micStream    !== null) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function finishListening() {
  stopMic();

  // Re-enable buttons
  singBtn.classList.remove('listening');
  singBtn.disabled = false;
  playBtn.disabled = false;

  // Always reveal the target note
  noteNameEl.textContent = targetNote.name;
  noteNameEl.className   = 'note-name revealed';
  noteHintEl.textContent = '';

  // Need at least a few good samples to score
  if (validSamples.length < 5) {
    showResult('声がよく聞こえませんでした — もっと大きな声でお試しください', 'error');
    setNeedle(0);
    return;
  }

  const medFreq = median(validSamples);
  const cents   = 1200 * Math.log2(medFreq / targetNote.freq);
  const absC    = Math.abs(cents);
  const sign    = cents >= 0 ? '+' : '';

  // Move needle to the final scored position
  setNeedle(cents);

  // Score & feedback
  stats.attempts++;
  if (absC <= 25) {
    stats.hits++;
    showResult(`完璧！ (${sign}${Math.round(cents)}¢)`, 'success');
  } else if (absC <= 60) {
    const dir = cents > 0 ? '少し高め' : '少し低め';
    showResult(`惜しい — ${dir} (${sign}${Math.round(cents)}¢)`, 'warning');
  } else {
    const dir = cents > 0 ? '高すぎ' : '低すぎ';
    showResult(`${Math.round(absC)}¢ ${dir}`, 'error');
  }

  // Update history (cap at 10)
  history.push({ cents: Math.round(cents), note: targetNote.name });
  if (history.length > 10) history.shift();

  saveStats();
  updateStatsUI();
  drawHistory();
}

// ── Event listeners ───────────────────────────────────────────────────────────
playBtn.addEventListener('click', playNote);
singBtn.addEventListener('click', listenForPitch);

resetBtn.addEventListener('click', () => {
  if (!confirm('統計と履歴をリセットしますか？')) return;
  stats   = { attempts: 0, hits: 0 };
  history = [];
  saveStats();
  updateStatsUI();
  drawHistory();
});

easyBtn.addEventListener('click', () => {
  currentMode = 'easy';
  easyBtn.classList.add('active');
  fullBtn.classList.remove('active');
});

fullBtn.addEventListener('click', () => {
  currentMode = 'full';
  fullBtn.classList.add('active');
  easyBtn.classList.remove('active');
});

// Redraw history chart if the window resizes (canvas needs explicit sizing)
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawHistory, 150);
});

// ── Boot ──────────────────────────────────────────────────────────────────────
loadStats();
