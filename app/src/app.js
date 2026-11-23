'use strict';
const $ = id => document.getElementById(id);
const state = {batches: [], selectedId: null, selectionError: null, batch: null, sample: [], winners: [], busy: false, loading: false, winner: null, page: 1, pages: 1, background: '', request: null};
const format = n => Number(n).toLocaleString('vi-VN');
let toastTimer, searchTimer, peopleController, stageVersion = 0, confettiFrame;
const settingsImages = [
  ['background', 'background', 'drawImage'],
  ['waiting-background', 'waitingBackground', 'waitingImage'],
  ['winner-background', 'winnerBackground', 'winnerImage'],
  ['reel-background', 'reelBackground', 'reelImage'],
  ['button-background', 'buttonBackground', 'buttonImage']
];
const thumbnailURLs = new Map();
function refreshSettingsImages() {
  for (const [id, setting, image] of settingsImages) {
    if (thumbnailURLs.has(id)) URL.revokeObjectURL(thumbnailURLs.get(id));
    thumbnailURLs.delete(id);
    const file = $(id + '-file').files[0];
    let source = state[setting] ? state[image] : '';
    if (file) {
      source = '';
      if (file.size <= 10_000_000 && ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        source = URL.createObjectURL(file);
        thumbnailURLs.set(id, source);
      }
    }
    const thumbnail = $(id + '-thumbnail');
    thumbnail.hidden = !source;
    if (source) thumbnail.src = source;
    else thumbnail.removeAttribute('src');
  }
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {$('toast').hidden = true;}, 6000);
}

async function api(path, data, signal) {
  return GalaStorage.route(path, data, signal);
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function setStats(batch) {
  $('stat-total').textContent = format(batch?.total || 0);
  $('stat-remaining').textContent = format(batch?.remaining || 0);
  $('stat-won').textContent = format(batch?.won || 0);
}

function controls() {
  const locked = state.busy || state.loading;
  $('spin').disabled = locked || (!state.batch?.remaining && !state.request);
  $('show-setup').disabled = locked;
  $('show-winners').disabled = locked;
  $('setup-batch').disabled = locked;
  $('add-batch').disabled = locked;
  $('create-batch').disabled = locked;
  $('import-button').disabled = locked || !state.batch;
  $('import-file').disabled = locked || !state.batch;
}

function updateBatchWarning() {
  const error = state.selectionError;
  const warning = $('batch-warning');
  warning.hidden = !error;
  warning.open = !!error;
  $('batch-warning-summary').textContent = error ? `Không tải được đợt ${state.selectedId}` : '';
  $('batch-warning-detail').textContent = error ? `${error.message}\nỨng dụng không xóa dữ liệu. Kiểm tra hoặc khôi phục đường dẫn của đợt này.` : '';
}

function populateSelectors() {
  for (const id of ['setup-batch']) {
    const select = $(id);
    select.replaceChildren();
    if (!state.batches.length && !GalaStorage.batchErrors.length) select.append(node('option', '', 'Chưa có đợt quay'));
    for (const batch of state.batches) {
      const option = node('option', '', batch.name);
      option.value = batch.id;
      select.append(option);
    }
    for (const error of GalaStorage.batchErrors) {
      const option = node('option', '', `Đợt ${error.id} · Không tải được`);
      option.value = error.id;
      select.append(option);
    }
    if (state.selectedId) select.value = state.selectedId;
  }
}

const layoutKeys = ['reelBorder', 'manualLayout', 'fitBackground', 'reelY', 'reelWidth', 'reelHeight', 'reelRadius', 'reelFont', 'buttonY', 'buttonWidth', 'buttonHeight', 'buttonRadius', 'buttonText', 'buttonTransparent'];
const winnerLayoutKeys = ['winnerWidth', 'winnerHeight', 'winnerContentY', 'winnerTransparent', 'winnerTextColor'];
function readWinnerLayout() {
  return Object.fromEntries(winnerLayoutKeys.map(key => [key, key === 'winnerTransparent' ? $('setting-' + key).checked : key === 'winnerTextColor' ? $('setting-' + key).value : Number($('setting-' + key).value)]));
}
function applyWinnerLayout(settings) {
  const popup = $('winner-dialog');
  for (const key of ['winnerWidth', 'winnerHeight', 'winnerContentY']) {
    popup.style.setProperty('--' + key, `${settings[key] ?? GalaStorage.defaults[key]}${key.endsWith('Y') ? '%' : 'px'}`);
  }
  popup.classList.toggle('transparent-background', settings.winnerTransparent === true);
  popup.style.setProperty('--winnerTextColor', settings.winnerTextColor ?? GalaStorage.defaults.winnerTextColor);

}
function readLayout() {
  return Object.fromEntries(layoutKeys.map(key => [key, ['reelBorder', 'manualLayout', 'buttonTransparent', 'fitBackground'].includes(key) ? $('setting-' + key).checked : key === 'buttonText' ? $('setting-' + key).value : Number($('setting-' + key).value)]));
}

let stageDesignHeight = 1080;
let stageLayoutSettings;
let stageImageVersion = 0;

function sizeStageFrame() {
  const scale = Math.min(innerWidth / 1920, innerHeight / stageDesignHeight);
  const root = document.documentElement.style;
  root.setProperty('--stage-scale', scale);
  root.setProperty('--stage-left', `${(innerWidth - 1920 * scale) / 2}px`);
  root.setProperty('--stage-top', `${(innerHeight - stageDesignHeight * scale) / 2}px`);
  root.setProperty('--stage-height', `${stageDesignHeight}px`);
}
window.addEventListener('resize', sizeStageFrame);
document.addEventListener('fullscreenchange', sizeStageFrame);

function applyLayout(settings) {
  stageLayoutSettings = {...settings};
  sizeStageFrame();
  document.body.classList.toggle('manual-layout', settings.manualLayout === true || settings.fitBackground === true);
  document.body.classList.toggle('fit-background', settings.fitBackground === true);
  document.body.classList.toggle('transparent-spin', settings.buttonTransparent === true);
  document.querySelector('.reel-shell').classList.toggle('show-border', settings.reelBorder === true);
  $('spin').textContent = String(settings.buttonText ?? GalaStorage.defaults.buttonText).trim();
  for (const key of layoutKeys.filter(key => !['reelBorder', 'manualLayout', 'buttonText', 'buttonTransparent', 'fitBackground'].includes(key))) {
    const value = Number(settings[key] ?? GalaStorage.defaults[key]);
    document.documentElement.style.setProperty('--' + key, `${settings.fitBackground && key.endsWith('Y') ? value * stageDesignHeight / 100 : settings.fitBackground && key === 'reelWidth' ? value * 19.2 : value}${settings.fitBackground ? 'px' : key.endsWith('Y') ? 'vh' : key === 'reelWidth' ? 'vw' : 'px'}`);
  }
}

function updateStageBackground() {
  const waiting = document.body.classList.contains('stage-waiting');
  const image = waiting ? state.waitingImage || state.drawImage : state.drawImage;
  document.body.style.backgroundImage = image ? `url("${image}")` : '';
  const version = ++stageImageVersion;
  const applySize = height => {
    if (version !== stageImageVersion) return;
    stageDesignHeight = height;
    if (stageLayoutSettings) applyLayout(stageLayoutSettings);
  };
  if (!image) {applySize(1080); return;}
  const probe = new Image();
  probe.onload = () => applySize(1920 * probe.naturalHeight / probe.naturalWidth);
  probe.onerror = () => applySize(1080);
  probe.src = image;
}

async function applySettings() {
  const settings = state.batch.settings;
  document.documentElement.style.setProperty('--accent', settings.accent);
  document.documentElement.style.setProperty('--bg', settings.backgroundColor);
  const [drawImage, waitingImage, buttonImage, reelImage, winnerImage] = await Promise.all([
    GalaStorage.background(settings.background), GalaStorage.background(settings.waitingBackground),
    GalaStorage.background(settings.buttonBackground), GalaStorage.background(settings.reelBackground),
    GalaStorage.background(settings.winnerBackground)
  ]);
  state.winnerImage = winnerImage;
  applyWinnerBackground(winnerImage);
  applyWinnerLayout(settings);
  $('setting-reelTextColor').value = settings.reelTextColor;
  document.documentElement.style.setProperty('--drawTextColor', settings.reelTextColor);
  for (const key of winnerLayoutKeys) {
    if (key === 'winnerTransparent') $('setting-' + key).checked = settings[key] === true;
    else $('setting-' + key).value = settings[key] ?? GalaStorage.defaults[key];
  }
  clearButtonPreview();
  clearReelPreview();
  state.reelImage = reelImage;
  document.querySelector('.reel-shell').style.backgroundImage = reelImage ? `url("${reelImage}")` : '';
  document.querySelector('.reel-shell').classList.toggle('has-background-image', Boolean(reelImage));
  state.buttonImage = buttonImage;
  $('spin').style.backgroundImage = buttonImage ? `url("${buttonImage}")` : '';
  state.drawImage = drawImage;
  state.waitingImage = waitingImage;
  updateStageBackground();
  $('stage-title').textContent = settings.title;
  $('stage-subtitle').textContent = settings.subtitle;
  $('stage-prize').textContent = settings.prize;
  $('stage-title').hidden = !settings.title.trim();
  $('stage-subtitle').hidden = !settings.subtitle.trim();
  document.querySelector('.hero').hidden = $('stage-title').hidden && $('stage-subtitle').hidden;
  document.querySelector('.prize-label').hidden = !settings.prize.trim();
  $('setting-title').value = settings.title;
  $('setting-subtitle').value = settings.subtitle;
  $('setting-prize').value = settings.prize;
  $('setting-accent').value = settings.accent;
  $('setting-bgcolor').value = settings.backgroundColor;
  $('setting-duration').value = settings.duration;
  for (const key of layoutKeys) {
    if (['reelBorder', 'manualLayout', 'buttonTransparent', 'fitBackground'].includes(key)) $('setting-' + key).checked = settings[key];
    else $('setting-' + key).value = settings[key];
  }
  applyLayout(settings);
  state.background = settings.background;
  state.waitingBackground = settings.waitingBackground;
  state.buttonBackground = settings.buttonBackground;
  state.reelBackground = settings.reelBackground;
  state.winnerBackground = settings.winnerBackground;
  $('winner-background-file').value = '';
  $('background-file').value = '';
  $('waiting-background-file').value = '';
  $('button-background-file').value = '';
  $('reel-background-file').value = '';
  refreshSettingsImages();
  $('export-all').href = '#';
  $('export-winners').href = '#';
  const report = state.batch.importReport;
  $('import-report').textContent = `Đã nhập ${format(report.accepted)} email · Bỏ ${format(report.duplicates)} email trùng · ${format(report.invalid)} dòng không hợp lệ.`;
}

function makeCard(person) {
  const card = node('div', 'email-card');
  const identity = [person.name, person.employeeCode].filter(Boolean).join(' - ');
  card.append(node('span', 'mail', person.email), node('span', 'card-name', identity || 'NGƯỜI MAY MẮN TIẾP THEO'));
  return card;
}

function paintTrack(position) {
  const track = $('reel-track');
  // Keep the pitch shared with CSS; relative units also work after a resize.
  track.dataset.position = String(position);
  track.style.transform = `translate3d(0,calc(var(--reel-pitch) * ${-position} - var(--reel-card-height) / 2),0)`;
  const children = track.children;
  const center = Math.round(position);
  // Only nearby cards are recalculated; total DOM stays bounded to 66 cards.
  for (let i = Math.max(0, center - 4); i <= Math.min(children.length - 1, center + 4); i++) {
    const distance = Math.abs(i - position);
    const influence = Math.max(0, 1 - distance / 1.25);
    children[i].style.transform = `scale(${.87 + .17 * influence})`;
    children[i].style.opacity = String(.25 + .75 * influence);
  }
}

function idleTrack() {
  const track = $('reel-track');
  const sample = state.sample.length ? state.sample : [{email: 'your.name@company.com', name: 'NGƯỜI MAY MẮN TIẾP THEO'}];
  track.replaceChildren(...Array.from({length: 9}, (_, i) => makeCard(sample[i % sample.length])));
  paintTrack(4);
}

async function selectBatch(id) {
  if (state.busy) return;
  const version = ++stageVersion;
  state.selectedId = id;
  state.selectionError = null;
  updateBatchWarning();
  state.loading = true;
  controls();
  try {
    const result = await api(`/api/batches/${id}/stage`);
    if (version !== stageVersion) return;
    state.batch = result.batch;
    state.sample = result.sample;
    updateBatchWarning();
    state.page = 1;
    localStorage.setItem('gala-batch', id);
    populateSelectors();
    setStats(state.batch);
    await applySettings();
    idleTrack();
    $('spin-status').textContent = state.batch.remaining ? 'MAY MẮN SẼ GỌI TÊN AI?' : 'ĐỢT QUAY ĐÃ HOÀN THÀNH';
    if ($('setup-dialog').open) await loadPeople();
    const pending = getPending();
    if (pending?.batchId === id) {
      state.request = pending;
      toast('Có lượt quay chưa hiển thị xong. Nhấn quay để khôi phục đúng kết quả đã lưu.');
    } else state.request = null;
  } catch (error) {
    if (version !== stageVersion) return;
    state.batch = null; state.sample = []; state.request = null;
    state.selectionError = error;
    setStats(null); idleTrack();
    $('spin-status').textContent = 'ĐỢT NÀY KHÔNG TẢI ĐƯỢC · HÃY CHỌN ĐỢT KHÁC';
    $('people-body').replaceChildren();
    updateBatchWarning();
    populateSelectors();
  } finally {
    if (version === stageVersion) {state.loading = false; controls();}
  }
}

function getPending() {
  try {return JSON.parse(localStorage.getItem('gala-pending') || 'null');}
  catch {return null;}
}

let reelAudio;
let reelClickBuffer;
let lastReelTick = -Infinity;

function prepareReelAudio() {
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    if (!reelAudio || reelAudio.state === 'closed') {
      reelAudio = new Audio();
      reelClickBuffer = null;
      lastReelTick = -Infinity;
    }
    // Unlock during the click/SPACE gesture, before any storage await.
    if (reelAudio.state === 'suspended') reelAudio.resume().catch(() => {});
  } catch {
    // Sound is optional: device/browser failures must never block a draw.
  }
}

function playReelTick() {
  if (!reelAudio || reelAudio.state !== 'running' || document.hidden) return;
  const now = reelAudio.currentTime;
  // Do not pile up catch-up sounds when frames skip several cards.
  if (now - lastReelTick < .025) return;
  let click, gain;
  try {
    if (!reelClickBuffer) {
      const rate = reelAudio.sampleRate;
      reelClickBuffer = reelAudio.createBuffer(1, Math.ceil(rate * .18), rate);
      const samples = reelClickBuffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) {
        const t = i / rate;
        const attack = Math.min(1, t / .001);
        const tail = Math.max(0, 1 - t / .18);
        // Fixed, inharmonic resonances give a bright metallic ting without a pitch sweep.
        samples[i] = attack * tail * (
          .5 * Math.sin(2 * Math.PI * 2200 * t) * Math.exp(-t * 22) +
          .28 * Math.sin(2 * Math.PI * 3527 * t) * Math.exp(-t * 32) +
          .15 * Math.sin(2 * Math.PI * 4973 * t) * Math.exp(-t * 48) +
          .07 * Math.sin(2 * Math.PI * 6811 * t) * Math.exp(-t * 75));
      }
    }
    click = reelAudio.createBufferSource();
    click.buffer = reelClickBuffer;
    gain = reelAudio.createGain();
    gain.gain.setValueAtTime(.24, now);
    click.connect(gain);
    gain.connect(reelAudio.destination);
    click.onended = () => {click.disconnect(); gain.disconnect();};
    click.start(now);
    click.stop(now + .18);
    lastReelTick = now;
  } catch {
    click?.disconnect();
    gain?.disconnect();
  }
}

function animateSpin(winner, duration) {
  const sample = state.sample.length ? state.sample : [winner.person];
  const target = 5, departure = 62;
  const cards = Array.from({length: 66}, () => makeCard(sample[Math.floor(Math.random() * sample.length)]));
  cards[target] = makeCard(winner.person);
  $('reel-track').replaceChildren(...cards);
  paintTrack(departure);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) duration = .4;
  return new Promise(resolve => {
    let start, previousCard = departure;
    const frame = timestamp => {
      start ??= timestamp;
      const t = Math.min(1, (timestamp - start) / (duration * 1000));
      // Fast departure and a long, smooth final settle on an exact card center.
      const eased = 1 - Math.pow(1 - t, 4);
      // Decreasing the card index moves the reel DOWN, then settles at center.
      const position = departure + (target - departure) * eased;
      paintTrack(position);
      const card = Math.round(position);
      if (card !== previousCard) {
        playReelTick();
        previousCard = card;
      }
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

async function highlightWinner() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const frame = document.querySelector('.center-frame');
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const animation = frame.animate([
    {backgroundColor: 'transparent'},
    {backgroundColor: accent, offset: .5},
    {backgroundColor: 'transparent'}
  ], {duration: 700, iterations: 3, easing: 'ease-in-out'});
  document.body.classList.add('winner-highlight');
  try {await animation.finished;}
  finally {
    animation.cancel();
    document.body.classList.remove('winner-highlight');
  }
}

function burstButtonNotes(box) {
  document.querySelectorAll('.button-notes').forEach(element => element.remove());
  const layer = node('div', 'button-notes');
  layer.setAttribute('aria-hidden', 'true');
  document.body.append(layer);
  const colors = ['#ff5fad', '#ffcf33', '#38e8ff', '#a98bff', '#69ffac', '#ff824d'];
  const animations = [];
  for (let i = 0; i < 18; i++) {
    const angle = i * Math.PI * 2 / 18;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const edge = 1 / Math.max(Math.abs(dx) / (box.width / 2 + 8), Math.abs(dy) / (box.height / 2 + 8));
    const note = node('span', 'button-note', ['♪', '♫', '♬'][i % 3]);
    Object.assign(note.style, {
      left: `${box.left + box.width / 2 + dx * edge}px`,
      top: `${box.top + box.height / 2 + dy * edge}px`,
      color: colors[i % colors.length], fontSize: `${28 + i % 3 * 6}px`
    });
    layer.append(note);
    const distance = 75 + i % 4 * 22;
    const rotation = (i % 2 ? 1 : -1) * (25 + i * 3);
    const animation = note.animate([
      {transform: 'translate(-50%, -50%) scale(.4)', opacity: 0},
      {opacity: 1, offset: .12},
      {opacity: 1, offset: .55},
      {transform: `translate(calc(-50% + ${dx * distance}px), calc(-50% + ${dy * distance - 35}px)) rotate(${rotation}deg) scale(1.15)`, opacity: 0}
    ], {duration: 1300, delay: i % 3 * 70, easing: 'cubic-bezier(.15,.6,.35,1)', fill: 'both'});
    animations.push(animation);
  }
  Promise.all(animations.map(animation => animation.finished.catch(() => {})))
    .finally(() => {animations.forEach(animation => animation.cancel()); layer.remove();});
}

function rippleSpinButton(event) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const button = $('spin');
  const box = button.getBoundingClientRect();
  burstButtonNotes(box);
  const pointer = event?.type === 'click' && event.detail > 0;
  const x = pointer ? (event.clientX - box.left) * button.offsetWidth / box.width - button.clientLeft : button.clientWidth / 2;
  const y = pointer ? (event.clientY - box.top) * button.offsetHeight / box.height - button.clientTop : button.clientHeight / 2;
  const radius = Math.hypot(Math.max(x, button.clientWidth - x), Math.max(y, button.clientHeight - y));
  button.querySelectorAll('.button-ripple').forEach(element => element.remove());
  for (let i = 0; i < 3; i++) {
    const wave = node('span', 'button-ripple');
    wave.setAttribute('aria-hidden', 'true');
    Object.assign(wave.style, {left: `${x}px`, top: `${y}px`, width: `${radius * 2}px`, height: `${radius * 2}px`});
    button.append(wave);
    const animation = wave.animate([
      {transform: 'translate(-50%, -50%) scale(0)', opacity: 1},
      {opacity: 1, offset: .6},
      {transform: 'translate(-50%, -50%) scale(1)', opacity: 0}
    ], {duration: 1100, delay: i * 160, easing: 'cubic-bezier(.15,.6,.35,1)', fill: 'both'});
    animation.finished.catch(() => {}).finally(() => {animation.cancel(); wave.remove();});
  }
}

async function spin(event) {
  if (document.body.classList.contains('stage-waiting')) return;
  if (state.busy || state.loading || !state.batch || (!state.batch.remaining && !state.request)) return;
  if (document.querySelector('dialog[open]')) return;
  prepareReelAudio();
  rippleSpinButton(event);
  state.busy = true;
  controls();
  document.body.classList.add('spinning');
  $('spin-status').textContent = 'ĐANG TÌM NGÔI SAO MAY MẮN…';
  try {
    if (!state.request) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      state.request = {batchId: state.batch.id, requestId: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''), prize: state.batch.settings.prize};
      // Persist before sending: a retry/reload cannot accidentally award twice.
      localStorage.setItem('gala-pending', JSON.stringify(state.request));
    }
    const winner = await api(`/api/batches/${state.batch.id}/draw`, state.request);
    state.batch.remaining = winner.remaining;
    state.batch.won = state.batch.total - winner.remaining;
    setStats(state.batch);
    await animateSpin(winner, state.batch.settings.duration);
    await highlightWinner();
    showWinner(winner);
    localStorage.removeItem('gala-pending');
    state.request = null;
    if ($('save-status')) $('save-status').textContent = '✓ Kết quả đã lưu trên máy';
    $('spin-status').textContent = 'CHÚC MỪNG NGƯỜI MAY MẮN!';
  } catch (error) {
    toast(`${error.message} Nhấn quay để thử lại cùng lượt, không quay trùng.`);
    $('spin-status').textContent = 'CHƯA HOÀN TẤT · NHẤN QUAY ĐỂ THỬ LẠI';
  } finally {
    state.busy = false;
    document.body.classList.remove('spinning');
    controls();
  }
}

function applyWinnerBackground(image) {
  $('winner-dialog').style.backgroundImage = image ? `url("${image}")` : '';
  $('winner-dialog').classList.toggle('has-background-image', Boolean(image));
}

function showWinner(winner) {
  state.winner = winner;
  $('winner-name').textContent = winner.person.name || 'NGÔI SAO MAY MẮN';
  $('winner-email').textContent = winner.person.email;
  $('winner-department').textContent = winner.person.department;
  $('winner-dialog').showModal();
  const sound = $('winner-sound');
  try {
    sound.currentTime = 0;
    sound.play().catch(() => {});
  } catch {
    // Missing files or blocked audio must not interrupt winner confirmation.
  }
  $('winner-dialog').focus();
  confetti();
}

async function closeWinner(absent = false) {
  if (!$('winner-dialog').open || state.busy) return;
  if (state.winnerPreview) {
    $('winner-dialog').close();
    state.winnerPreview = false;
    if (state.winnerPreviewURL) URL.revokeObjectURL(state.winnerPreviewURL);
    state.winnerPreviewURL = '';
    applyWinnerBackground(state.winnerImage);
    applyWinnerLayout(state.batch.settings);
    $('setup-dialog').showModal();
    return;
  }
  state.busy = true;
  try {
    if (absent) {
      await api(`/api/batches/${state.batch.id}/absent`, {winId: state.winner.id});
      toast('Đã đánh dấu vắng mặt. Email vẫn được loại khỏi đợt quay.');
    }
    $('winner-dialog').close();
    $('winner-sound').pause();
    $('winner-sound').currentTime = 0;
    stopConfetti();
    // Refresh the bounded sample so subsequent animations don't show prior winners.
    const result = await api(`/api/batches/${state.batch.id}/stage`);
    state.sample = result.sample;
    state.batch = result.batch;
    setStats(state.batch);
    idleTrack();
    $('spin-status').textContent = state.batch.remaining ? 'SẴN SÀNG CHO KHOẢNH KHẮC TIẾP THEO' : 'ĐỢT QUAY ĐÃ HOÀN THÀNH';
  } catch (error) {toast(error.message);}
  finally {
    state.busy = false;
    controls();
  }
}

function stopConfetti() {
  cancelAnimationFrame(confettiFrame);
  $('confetti').style.display = 'none';
}

function confetti() {
  stopConfetti();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = $('confetti');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = innerWidth, height = innerHeight;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  ctx.scale(ratio, ratio);
  canvas.style.display = 'block';
  const colors = ['#ff246b', '#ffcf00', '#00e5ff', '#7c4dff', '#39ff88', '#ff7417', '#ff43dc', '#ffffff'];
  const perBurst = width < 600 ? 140 : 240;
  const pieces = Array.from({length: perBurst * 3}, (_, i) => {
    const burst = Math.floor(i / perBurst);
    return {x: i % 2 ? width * .08 : width * .92, y: height * (.7 - burst * .08),
      vx: (i % 2 ? 1 : -1) * (3 + Math.random() * 12), vy: -10 - Math.random() * 18,
      delay: burst * 650, size: 5 + Math.random() * 8, color: colors[i % colors.length], rotation: Math.random() * 6};
  });
  let start, previous;
  const frame = timestamp => {
    start ??= timestamp;
    const delta = Math.min(2, (timestamp - (previous ?? timestamp)) / 16.67);
    previous = timestamp;
    ctx.clearRect(0, 0, width, height);
    for (const p of pieces) {
      const age = timestamp - start - p.delay;
      if (age < 0) continue;
      p.x += p.vx * delta; p.y += p.vy * delta; p.vy += .16 * delta; p.vx *= Math.pow(.992, delta); p.rotation += .07 * delta;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rotation);
      ctx.fillStyle = p.color; ctx.globalAlpha = Math.min(1, Math.max(0, (6000 - age) / 1800));
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * .5); ctx.restore();
    }
    if (timestamp - start < 7300) confettiFrame = requestAnimationFrame(frame);
    else stopConfetti();
  };
  confettiFrame = requestAnimationFrame(frame);
}

function badge(win) {
  return node('span', `badge ${win ? win.absent ? 'absent' : 'won' : 'eligible'}`, win ? win.absent ? 'Vắng mặt' : 'Trúng giải' : 'Chưa trúng');
}

async function loadPeople() {
  peopleController?.abort();
  if (!state.batch) {
    $('people-body').replaceChildren();
    return;
  }
  peopleController = new AbortController();
  try {
    const query = new URLSearchParams({q: $('people-search').value, status: $('people-filter').value, page: state.page});
    const result = await api(`/api/batches/${state.batch.id}/people?${query}`, undefined, peopleController.signal);
    state.pages = Math.max(1, Math.ceil(result.total / result.pageSize));
    if (state.page > state.pages) {state.page = state.pages; return loadPeople();}
    const fragment = document.createDocumentFragment();
    for (const person of result.items) {
      const row = node('tr');
      const identity = node('td', '', person.name || '—');
      identity.append(node('small', '', [person.employeeCode, person.email].filter(Boolean).join(' · ')));
      const status = node('td'); status.append(badge(person.win));
      row.append(identity, node('td', '', person.department || '—'), status, node('td', '', person.win?.prize || '—'));
      fragment.append(row);
    }
    if (!result.items.length) {
      const row = node('tr'), cell = node('td', 'empty', 'Không tìm thấy nhân sự.');
      cell.colSpan = 4; row.append(cell); fragment.append(row);
    }
    $('people-body').replaceChildren(fragment);
    $('people-count').textContent = `${format(result.total)} nhân sự · 50 dòng / trang`;
    $('page-label').textContent = `${state.page} / ${state.pages}`;
    $('prev-page').disabled = state.page <= 1;
    $('next-page').disabled = state.page >= state.pages;
  } catch (error) {if (error.name !== 'AbortError') toast(error.message);}
}

async function openSetup() {
  if (state.busy || state.loading) return;
  $('setup-dialog').showModal();
  $('settings-form').querySelectorAll('input,button').forEach(el => el.disabled = !state.batch);
  await loadPeople();
}

async function openWinners() {
  if (!state.batch) return toast('Hãy tạo đợt quay trong Thiết lập trước.');
  if (state.busy || state.loading) return;
  if (!$('winners-dialog').open) $('winners-dialog').showModal();
  $('winners-batch').textContent = state.batch.name;
  $('winners-list').replaceChildren(node('p', 'empty', 'Đang tải kết quả…'));
  try {
    const winners = await api(`/api/batches/${state.batch.id}/winners`);
    state.winners = winners;
    const absent = winners.filter(w => w.absent).length;
    $('winners-count').textContent = `${format(winners.length)} người trúng · ${format(absent)} vắng mặt`;
    // Render in batches to keep even unusually large histories responsive.
    $('winners-list').replaceChildren();
    let shown = 0;
    function appendMore() {
      const fragment = document.createDocumentFragment();
      const end = Math.min(winners.length, shown + 50);
      for (; shown < end; shown++) {
        const winner = winners[shown];
        const item = node('div', 'winner-item');
        const person = node('div', 'winner-person');
        person.append(node('strong', '', winner.person.name || winner.person.email), node('p', '', winner.person.email),
          node('small', '', `${winner.prize} · ${new Date(winner.at).toLocaleString('vi-VN')}`));
        item.append(node('span', 'winner-index', String(winners.length - shown).padStart(2, '0')), person, badge(winner));
        if (!winner.absent) {
          const mark = node('button', 'secondary', 'Đánh dấu vắng');
          mark.addEventListener('click', async () => {
            mark.disabled = true;
            try {await api(`/api/batches/${state.batch.id}/absent`, {winId: winner.id}); await openWinners();}
            catch (error) {toast(error.message); mark.disabled = false;}
          });
          item.append(mark);
        }
        fragment.append(item);
      }
      $('winners-list').append(fragment);
      if (shown < winners.length) {
        const more = node('button', 'secondary', 'Xem thêm 50 kết quả');
        more.addEventListener('click', () => {more.remove(); appendMore();});
        $('winners-list').append(more);
      }
    }
    if (winners.length) appendMore();
    else $('winners-list').append(node('p', 'empty', 'Chưa có ngôi sao nào được gọi tên. Khoảnh khắc may mắn đang chờ!'));
  } catch (error) {toast(error.message);}
}

$('add-batch').addEventListener('click', () => {
  $('create-batch-form').hidden = !$('create-batch-form').hidden;
  $('add-batch').setAttribute('aria-expanded', String(!$('create-batch-form').hidden));
  if (!$('create-batch-form').hidden) $('batch-name').focus();
});
$('create-batch-form').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('batch-name').value.trim();
  if (!name || state.loading || state.busy) return;
  state.loading = true; controls();
  try {
    const batch = await api('/api/batches', {name});
    state.batches.unshift(batch);
    await selectBatch(batch.id);
    $('settings-form').querySelectorAll('input,button').forEach(el => el.disabled = false);
    $('create-batch-form').reset();
    $('create-batch-form').hidden = true;
    $('add-batch').setAttribute('aria-expanded', 'false');
    toast('Đã tạo đợt mới. Có thể nhập danh sách nhân sự sau.');
  } catch (error) {toast(error.message);}
  finally {state.loading = false; controls();}
});

$('import-form').addEventListener('submit', async event => {
  event.preventDefault();
  const file = $('import-file').files[0];
  if (!file || !state.batch || state.loading || state.busy) return;
  const batchId = state.batch.id;
  const confirmReset = state.batch.won > 0;
  if (confirmReset && !window.confirm(`Đợt “${state.batch.name}” đã có ${format(state.batch.won)} người trúng. Upload này sẽ thay toàn bộ nhân sự và xóa toàn bộ kết quả trúng/vắng mặt để quay lại từ đầu. Bạn có chắc chắn tiếp tục?`)) return;
  $('import-button').disabled = true;
  $('import-button').textContent = 'Đang đọc & lưu danh sách…';
  state.loading = true; controls();
  try {
    const batch = await api(`/api/batches/${batchId}/import`, {file, confirmReset});
    if (getPending()?.batchId === batchId) localStorage.removeItem('gala-pending');
    state.request = null; state.winner = null; state.winners = [];
    state.batches = state.batches.map(item => item.id === batch.id ? batch : item);
    await selectBatch(batch.id);
    $('settings-form').querySelectorAll('input,button').forEach(el => el.disabled = false);
    $('import-form').reset();
    toast(`Đã thay danh sách: ${format(batch.total)} nhân sự. Kết quả đã reset, sẵn sàng quay từ đầu.`);
  } catch (error) {toast(error.message);}
  finally {state.loading = false; controls(); $('import-button').textContent = 'Nhập / thay danh sách';}
});

$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.batch || state.busy || state.loading) return;
  state.loading = true; controls(); $('save-settings').disabled = true;
  try {
    const file = $('background-file').files[0];
    if (file) state.background = (await api('/api/background', {file})).url;
    const waitingFile = $('waiting-background-file').files[0];
    if (waitingFile) state.waitingBackground = (await api('/api/background', {file: waitingFile})).url;
    const buttonFile = $('button-background-file').files[0];
    if (buttonFile) state.buttonBackground = (await api('/api/background', {file: buttonFile})).url;
    const reelFile = $('reel-background-file').files[0];
    if (reelFile) state.reelBackground = (await api('/api/background', {file: reelFile})).url;
    const winnerFile = $('winner-background-file').files[0];
    if (winnerFile) state.winnerBackground = (await api('/api/background', {file: winnerFile})).url;
    state.batch = await api(`/api/batches/${state.batch.id}/settings`, {
      title: $('setting-title').value, subtitle: $('setting-subtitle').value, prize: $('setting-prize').value,
      accent: $('setting-accent').value, backgroundColor: $('setting-bgcolor').value,
      duration: Number($('setting-duration').value), background: state.background, waitingBackground: state.waitingBackground, buttonBackground: state.buttonBackground, reelBackground: state.reelBackground, winnerBackground: state.winnerBackground, ...readLayout(), ...readWinnerLayout(), reelTextColor: $('setting-reelTextColor').value});
    await applySettings(); toast('Đã lưu thiết lập riêng cho đợt này.');
  } catch (error) {toast(error.message);}
  finally {state.loading = false; controls(); $('save-settings').disabled = false;}
});

$('remove-background').addEventListener('click', () => {state.background = ''; $('background-file').value = ''; toast('Sẽ bỏ ảnh nền khi nhấn Lưu thiết lập.');});
$('remove-waiting-background').addEventListener('click', () => {state.waitingBackground = ''; $('waiting-background-file').value = ''; toast('Sẽ bỏ ảnh màn chờ khi nhấn Lưu thiết lập.');});
$('remove-winner-background').addEventListener('click', () => {
  state.winnerBackground = '';
  $('winner-background-file').value = '';
  toast('Sẽ bỏ ảnh nền popup khi nhấn Lưu thiết lập.');
});
$('preview-winner-background').addEventListener('click', () => {
  if (!state.batch || state.busy || state.loading) return;
  if (!winnerLayoutKeys.every(key => $('setting-' + key).reportValidity())) return;
  applyWinnerLayout(readWinnerLayout());
  const file = $('winner-background-file').files[0];
  if (file && (file.size > 10_000_000 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) {
    toast('Chọn ảnh PNG, JPG, WebP tối đa 10 MB.'); return;
  }
  state.winnerPreviewURL = file ? URL.createObjectURL(file) : '';
  applyWinnerBackground(state.winnerPreviewURL || (state.winnerBackground ? state.winnerImage : ''));
  $('winner-name').textContent = 'NGƯỜI TRÚNG GIẢI MẪU';
  $('winner-email').textContent = 'nhansu@example.com';
  $('winner-department').textContent = 'XEM THỬ · KHÔNG LƯU KẾT QUẢ';
  state.winnerPreview = true;
  $('setup-dialog').close();
  $('winner-dialog').showModal();
  $('winner-dialog').focus();
});
function clearButtonPreview() {
  if (state.buttonPreviewURL) URL.revokeObjectURL(state.buttonPreviewURL);
  state.buttonPreviewURL = '';
}
$('button-background-file').addEventListener('change', clearButtonPreview);
function clearReelPreview() {
  if (state.reelPreviewURL) URL.revokeObjectURL(state.reelPreviewURL);
  state.reelPreviewURL = '';
}
$('reel-background-file').addEventListener('change', clearReelPreview);
$('remove-reel-background').addEventListener('click', () => {
  clearReelPreview();
  state.reelBackground = '';
  $('reel-background-file').value = '';
  toast('Sẽ bỏ ảnh nền ô quay số khi nhấn Lưu thiết lập.');
});
$('remove-button-background').addEventListener('click', () => {
  clearButtonPreview();
  state.buttonBackground = '';
  $('button-background-file').value = '';
  toast('Sẽ bỏ ảnh nền nút quay số khi nhấn Lưu thiết lập.');
});
$('preview-layout').addEventListener('click', () => {
  if (!$('settings-form').reportValidity()) return;
  const reelFile = $('reel-background-file').files[0];
  if (reelFile && (reelFile.size > 10_000_000 || !['image/png', 'image/jpeg', 'image/webp'].includes(reelFile.type))) {
    toast('Chọn ảnh PNG, JPG, WebP tối đa 10 MB.'); return;
  }
  clearButtonPreview();
  const buttonFile = $('button-background-file').files[0];
  if (buttonFile) {
    if (buttonFile.size > 10_000_000 || !['image/png', 'image/jpeg', 'image/webp'].includes(buttonFile.type)) {
      toast('Chọn ảnh PNG, JPG, WebP tối đa 10 MB.'); return;
    }
    state.buttonPreviewURL = URL.createObjectURL(buttonFile);
  }
  const buttonImage = state.buttonPreviewURL || (state.buttonBackground ? state.buttonImage : '');
  $('spin').style.backgroundImage = buttonImage ? `url("${buttonImage}")` : '';
  clearReelPreview();
  if (reelFile) state.reelPreviewURL = URL.createObjectURL(reelFile);
  const reelImage = state.reelPreviewURL || (state.reelBackground ? state.reelImage : '');
  document.querySelector('.reel-shell').style.backgroundImage = reelImage ? `url("${reelImage}")` : '';
  document.querySelector('.reel-shell').classList.toggle('has-background-image', Boolean(reelImage));
  applyLayout(readLayout());
  document.documentElement.style.setProperty('--drawTextColor', $('setting-reelTextColor').value);
  applyWinnerLayout(readWinnerLayout());
  document.body.classList.remove('stage-waiting');
  updateStageBackground();
  $('stage').inert = false;
  $('stage').setAttribute('aria-hidden', 'false');
  document.querySelector('.stage-tools').inert = false;
  $('setup-dialog').close();
});
$('reset-layout').addEventListener('click', () => {
  clearReelPreview();
  state.reelBackground = '';
  $('reel-background-file').value = '';
  clearButtonPreview();
  state.buttonBackground = '';
  $('button-background-file').value = '';
  for (const key of layoutKeys) {
    if (['reelBorder', 'manualLayout', 'buttonTransparent', 'fitBackground'].includes(key)) $('setting-' + key).checked = GalaStorage.defaults[key];
    else $('setting-' + key).value = GalaStorage.defaults[key];
  }
});
$('setup-batch').addEventListener('change', event => selectBatch(event.target.value));
for (const [id] of settingsImages) {
  $(id + '-file').addEventListener('change', refreshSettingsImages);
  $('remove-' + id).addEventListener('click', refreshSettingsImages);
}
$('reset-layout').addEventListener('click', refreshSettingsImages);
$('settings-form').addEventListener('invalid', event => {
  const group = event.target.closest('details');
  if (group) group.open = true;
}, true);
$('spin').addEventListener('click', spin);
$('show-setup').addEventListener('click', openSetup);
$('show-winners').addEventListener('click', openWinners);
document.querySelectorAll('.close').forEach(button => button.addEventListener('click', () => {if (!state.loading) button.closest('dialog').close();}));
$('winner-dialog').addEventListener('cancel', event => {event.preventDefault(); closeWinner();});
$('setup-dialog').addEventListener('cancel', event => {if (state.loading) event.preventDefault();});
$('people-search').addEventListener('input', () => {clearTimeout(searchTimer); state.page = 1; searchTimer = setTimeout(loadPeople, 220);});
$('people-filter').addEventListener('change', () => {state.page = 1; loadPeople();});
$('prev-page').addEventListener('click', () => {if (state.page > 1) {state.page--; loadPeople();}});
$('next-page').addEventListener('click', () => {if (state.page < state.pages) {state.page++; loadPeople();}});

async function fullscreen() {
  try {if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen();}
  catch {toast('Trình duyệt không hỗ trợ toàn màn hình. Có thể dùng F11.');}
}
$('fullscreen').addEventListener('click', fullscreen);
$('waiting-fullscreen').addEventListener('click', fullscreen);
document.addEventListener('fullscreenchange', () => {
  const active = !!document.fullscreenElement;
  for (const id of ['fullscreen', 'waiting-fullscreen']) {
    $(id).setAttribute('aria-pressed', String(active));
    $(id).setAttribute('aria-label', active ? 'Thoát toàn màn hình' : 'Toàn màn hình');
    $(id).title = active ? 'Thoát toàn màn hình (F)' : 'Toàn màn hình (F)';
    $(id).textContent = active ? '⊡' : '⛶';
  }
});
document.addEventListener('keydown', event => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable) return;
  if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) {
    if (document.querySelector('dialog[open]') || state.busy || state.loading || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const waiting = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    document.body.classList.toggle('stage-waiting', waiting);
    updateStageBackground();
    $('stage').inert = waiting;
    $('stage').setAttribute('aria-hidden', String(waiting));
    document.querySelector('.stage-tools').inert = waiting;
    if (waiting) {
      document.activeElement.blur();
      $('toast').hidden = true;
      window.scrollTo(0, 0);
    }
    return;
  }
  if (event.code === 'Space') {
    event.preventDefault();
    if (event.repeat) return;
    if ($('winner-dialog').open) closeWinner();
    else if (!document.querySelector('dialog[open]')) spin();
  } else if (event.key.toLowerCase() === 'v' && $('winner-dialog').open) {
    event.preventDefault(); if (!event.repeat) closeWinner(true);
  } else if (event.key.toLowerCase() === 'f' && !event.repeat) fullscreen();
});

async function init() {
  idleTrack(); controls();
  try {
    state.batches = await api('/api/batches');
    const errors = GalaStorage.batchErrors;
    updateBatchWarning();
    populateSelectors();
    if (state.batches.length) {
      const pending = getPending();
      const saved = pending?.batchId || localStorage.getItem('gala-batch');
      await selectBatch(state.batches.some(b => b.id === saved) ? saved : state.batches[0].id);
      // If the final email was awarded before a reload, still allow replaying that request.
      if (state.request) $('spin').disabled = false;
    } else if (errors.length) {
      await selectBatch(errors[0].id);
    } else {
      $('spin-status').textContent = errors.length ? 'KHÔNG TẢI ĐƯỢC DỮ LIỆU ĐỢT QUAY · XEM CẢNH BÁO PHÍA TRÊN' : 'VÀO THIẾT LẬP ⚙ ĐỂ TẠO ĐỢT QUAY ĐẦU TIÊN';
      if (!errors.length) toast('Chào mừng đến Gala Spin! Mở ⚙ để nhập danh sách nhân sự.');
    }
  } catch (error) {toast(`Không đọc được thư mục: ${error.message}`);}
}
for (const [id, onlyWins] of [['export-all', false], ['export-winners', true]]) {
  $(id).addEventListener('click', async event => {
    event.preventDefault();
    if (!state.batch || state.busy || state.loading) return;
    state.loading = true; controls();
    try {
      const blob = await GalaStorage.exportBatch(state.batch.id, onlyWins);
      GalaStorage.download(blob, `gala-${state.batch.id}.xlsx`);
      toast('Đã lưu Excel vào thư mục đợt quay và tải bản sao.');
    } catch (error) {toast(error.message);}
    finally {state.loading = false; controls();}
  });
}
$('download-template').addEventListener('click', async event => {
  event.preventDefault();
  try {GalaStorage.download(await GalaExcel.write(GalaExcel.templateRows), 'mau-nhan-su.xlsx');}
  catch (error) {toast(error.message);}
});
document.querySelector('.stage-tools').inert = document.body.classList.contains('stage-waiting');
window.galaEnvironmentReady.then(ready => {if (ready) init();});