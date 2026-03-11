/* ============================================================
   FaceDetect – app.js
   • Face  → MediaPipe FaceDetection → amber glowing box + landmark dots + label chip
   • Hand  → MediaPipe Hands         → teal glowing box + skeleton + fingertip dots
   ============================================================ */

/* MediaPipe hand connections */
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [17, 18], [18, 19], [19, 20],
  [0, 5], [5, 9], [9, 13], [13, 17], [0, 17]
];
const FINGERTIP_IDS = [4, 8, 12, 16, 20];
const FINGERTIP_NAMES = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];

/* ── DOM ── */
const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const pillDot = document.getElementById('pillDot');
const statusText = document.getElementById('statusText');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const loadingScreen = document.getElementById('loadingScreen');
const loadSub = document.getElementById('loadSub');
const loadBar = document.getElementById('loadBar');
const placeholder = document.getElementById('placeholder');

/* ── State ── */
let stream = null;
let rafId = null;
let running = false;
let faceModel = null;    // MediaPipe FaceDetection
let handsModel = null;    // MediaPipe Hands
let lastFaceResults = [];
let lastHandResults = [];
let lastHandedness = [];

/* ─────────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────────── */
function setStatus(msg, state = 'idle') {
  statusText.textContent = msg;
  pillDot.className = 'pill-dot ' + state;
}

/* Draw a filled label chip above a bounding box */
function drawChip(ctx, text, x, y, bgColor, fontSize = 13) {
  ctx.save();
  ctx.font = `700 ${fontSize}px Inter, sans-serif`;
  const tw = ctx.measureText(text).width;
  const padX = 9, padY = 5;
  const w = tw + padX * 2;
  const h = fontSize + padY * 2;
  const cy = y - h - 6;
  ctx.fillStyle = bgColor;
  ctx.fillRect(x, Math.max(2, cy), w, h);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, x + padX, Math.max(2 + h / 2, cy + h / 2));
  ctx.restore();
}

/* Draw glowing bounding box with corner brackets */
function drawBox(ctx, x, y, w, h, color, glowColor) {
  /* wide soft halo */
  ctx.save();
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = 28;
  ctx.strokeStyle = glowColor;
  ctx.lineWidth = 10;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();

  /* tighter bright ring */
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.5;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();

  /* corner brackets */
  const cLen = Math.min(w, h) * 0.20;
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  [
    [x, y, cLen, cLen],
    [x + w, y, -cLen, cLen],
    [x, y + h, cLen, -cLen],
    [x + w, y + h, -cLen, -cLen],
  ].forEach(([cx, cy, dx, dy]) => {
    ctx.beginPath();
    ctx.moveTo(cx + dx, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + dy);
    ctx.stroke();
  });
  ctx.restore();
}

/* ─────────────────────────────────────────────────────────────
   LOAD MODELS
───────────────────────────────────────────────────────────── */
const MP_FACE_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/face_detection@0.4.1646425229';
const MP_HAND_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915';

async function loadModels() {
  setStatus('Loading models…', 'loading');
  loadBar.style.width = '10%';

  /* 1. MediaPipe FaceDetection */
  loadSub.textContent = 'Initialising face detection model…';
  faceModel = new FaceDetection({
    locateFile: f => `${MP_FACE_CDN}/${f}`
  });
  faceModel.setOptions({
    model: 'short',               // optimised for <2 m range (webcam)
    minDetectionConfidence: 0.5
  });
  faceModel.onResults(results => {
    lastFaceResults = results.detections || [];
  });
  await faceModel.initialize();
  loadBar.style.width = '55%';

  /* 2. MediaPipe Hands */
  loadSub.textContent = 'Initialising hand-tracking model…';
  handsModel = new Hands({
    locateFile: f => `${MP_HAND_CDN}/${f}`
  });
  handsModel.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.5
  });
  handsModel.onResults(results => {
    lastHandResults = results.multiHandLandmarks || [];
    lastHandedness = results.multiHandedness || [];
  });
  await handsModel.initialize();

  loadBar.style.width = '100%';
  loadSub.textContent = 'All models ready!';
  setTimeout(() => {
    loadingScreen.classList.add('hidden');
    setStatus('Ready — click Start Camera', 'idle');
  }, 500);
}

/* ─────────────────────────────────────────────────────────────
   START / STOP
───────────────────────────────────────────────────────────── */
async function startCamera() {
  if (!faceModel || !handsModel) { alert('Models still loading…'); return; }
  setStatus('Requesting camera…', 'loading');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false
    });
    video.srcObject = stream;
    await new Promise(res => { video.onloadedmetadata = res; });
    await video.play();

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;

    running = true;
    placeholder.classList.add('hidden');
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus('Tracking face & hands…', 'active');

    detectLoop();
  } catch (err) {
    setStatus('Camera access denied', 'error');
    alert(`Camera error:\n${err.message}`);
  }
}

function stopCamera() {
  running = false;
  cancelAnimationFrame(rafId);
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  lastFaceResults = [];
  lastHandResults = [];
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  placeholder.classList.remove('hidden');
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('Stopped — click Start Camera to resume', 'idle');
}

/* ─────────────────────────────────────────────────────────────
   MAIN DETECTION LOOP
───────────────────────────────────────────────────────────── */
async function detectLoop() {
  if (!running) return;

  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  /* ── Face detection ── */
  try { await faceModel.send({ image: video }); } catch (_) { }

  /* ── Hand detection ── */
  try { await handsModel.send({ image: video }); } catch (_) { }

  /* ── Draw ── */
  drawFaces(ctx, lastFaceResults);
  drawHands(ctx, lastHandResults, lastHandedness);

  rafId = requestAnimationFrame(detectLoop);
}

/* ─────────────────────────────────────────────────────────────
   DRAW FACES
   MediaPipe FaceDetection result per detection:
     boundingBox: { xCenter, yCenter, width, height }  — normalised
     landmarks:   [ {x,y} × 6 ]                        — normalised
     score:       [ 0..1 ]
───────────────────────────────────────────────────────────── */
function drawFaces(ctx, detections) {
  const W = canvas.width, H = canvas.height;

  detections.forEach((det, i) => {
    const bb = det.boundingBox;
    /* MediaPipe gives xCenter/yCenter + width/height (all normalised 0-1) */
    const bx = (bb.xCenter - bb.width / 2) * W;
    const by = (bb.yCenter - bb.height / 2) * H;
    const bw = bb.width * W;
    const bh = bb.height * H;
    const conf = Math.round((det.score?.[0] ?? det.score ?? 1) * 100);

    /* 1 · Glowing amber box */
    drawBox(ctx, bx, by, bw, bh, '#f59e0b', 'rgba(245,158,11,0.6)');

    /* 2 · "Face N · XX%" label chip */
    drawChip(ctx, `Face ${i + 1}  ·  ${conf}%`, bx, by, '#d97706', 13);

    /* 3 · 6 key-point dots (eyes, ears, nose, mouth) */
    if (det.landmarks) {
      det.landmarks.forEach(lm => {
        const px = lm.x * W, py = lm.y * H;
        ctx.save();
        ctx.shadowColor = '#f59e0b';
        ctx.shadowBlur = 6;
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.arc(px, py, 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });
    }
  });
}

/* ─────────────────────────────────────────────────────────────
   DRAW HANDS
───────────────────────────────────────────────────────────── */
function drawHands(ctx, handsLandmarks, handedness) {
  const W = canvas.width, H = canvas.height;

  const COLORS = {
    box: '#10b981',
    glow: 'rgba(16,185,129,0.6)',
    skeleton: 'rgba(52,211,153,0.9)',
    dot: '#34d399',
    tip: '#f43f5e',
    tipGlow: 'rgba(244,63,94,0.7)',
    chip: '#059669',
  };

  handsLandmarks.forEach((landmarks, hi) => {
    const px = landmarks.map(p => ({ x: p.x * W, y: p.y * H }));

    /* Bounding box from landmark extents */
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    px.forEach(({ x, y }) => {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    });
    const pad = 20;
    const bx = minX - pad, by = minY - pad;
    const bw = (maxX - minX) + pad * 2, bh = (maxY - minY) + pad * 2;

    /* 1 · Glowing teal box */
    drawBox(ctx, bx, by, bw, bh, COLORS.box, COLORS.glow);

    /* 2 · Label chip */
    const side = handedness[hi]?.label ?? `Hand ${hi + 1}`;
    drawChip(ctx, `Hand Detection  ·  ${side}`, bx, by, COLORS.chip, 13);

    /* 3 · Skeleton lines */
    ctx.save();
    ctx.strokeStyle = COLORS.skeleton;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = COLORS.box;
    ctx.shadowBlur = 5;
    HAND_CONNECTIONS.forEach(([a, b]) => {
      ctx.beginPath();
      ctx.moveTo(px[a].x, px[a].y);
      ctx.lineTo(px[b].x, px[b].y);
      ctx.stroke();
    });
    ctx.restore();

    /* 4 · Landmark dots */
    px.forEach(({ x, y }, idx) => {
      const isTip = FINGERTIP_IDS.includes(idx);
      ctx.save();

      if (isTip) {
        /* Glowing red fingertip */
        ctx.shadowColor = COLORS.tipGlow;
        ctx.shadowBlur = 18;
        ctx.fillStyle = COLORS.tip;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();

        /* Finger name mini-label */
        const name = FINGERTIP_NAMES[FINGERTIP_IDS.indexOf(idx)];
        ctx.font = '700 11px Inter, sans-serif';
        ctx.textAlign = 'center';
        const nw = ctx.measureText(name).width + 10;
        const nx = x - nw / 2, ny = y - 22;
        ctx.fillStyle = 'rgba(244,63,94,0.9)';
        ctx.fillRect(nx, ny, nw, 17);
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        ctx.fillText(name, x, ny + 8.5);

      } else {
        /* Regular joint dot */
        ctx.shadowColor = COLORS.box;
        ctx.shadowBlur = 6;
        ctx.fillStyle = COLORS.dot;
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.arc(x, y, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });
  });
}

/* ─────────────────────────────────────────────────────────────
   EVENTS & BOOT
───────────────────────────────────────────────────────────── */
startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);

loadModels().catch(err => {
  console.error(err);
  loadSub.textContent = '⚠ Failed to load models. Check internet connection.';
});
