// Dependency-free UI verification over Chrome DevTools Protocol.
// UI smoke over a test-only loopback origin, with REAL OPFS handles in a disposable profile.
// Native OS picker permission still requires manual QA on the gala machine.
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, mkdir, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {deflateRawSync} from 'node:zlib';

// Independently generated, deflated XLSX using sharedStrings and a nonstandard
// first-sheet filename: exercises real-world import, not only our own writer.
function compressedWorkbook() {
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  const files = {
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Staff" sheetId="1" r:id="rId9"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Target="worksheets/staff.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>email</t></si><si><t>name</t></si><si><t>department</t></si><si><t>USER@example.com</t></si><si><r><t>Nguyễn </t></r><r><t>Văn A</t></r></si><si><t>IT</t></si><si><t>invalid</t></si></sst>',
    'xl/worksheets/staff.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>5</v></c></row><row r="3"><c r="A3" t="s"><v>3</v></c></row><row r="4"><c r="A4" t="s"><v>6</v></c></row></sheetData></worksheet>'
  };
  const local = [], central = []; let offset = 0, centralSize = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name), bytes = Buffer.from(value), compressed = deflateRawSync(bytes), crc = crc32(bytes);
    const header = Buffer.alloc(30 + filename.length);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26); filename.copy(header, 30);
    const record = Buffer.alloc(46 + filename.length);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42); filename.copy(record, 46);
    local.push(header, compressed); central.push(record); offset += header.length + compressed.length; centralSize += record.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(tmpdir(), 'gala-browser-'));
const chrome = process.env.CHROME_PATH || '/opt/google/chrome/chrome';
const debugPort = 19223;
let browser, ws;
// Test harness only: OPFS is unavailable under file:// in Chromium; use loopback
// to obtain real filesystem handles. The shipping app never starts a server.
const testServer = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (relative.includes('..')) {res.writeHead(404).end(); return;}
  try {
    const bytes = await readFile(path.join(root, '..', relative));
    res.setHeader('Content-Type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.mp3') ? 'audio/mpeg' : 'text/html');
    res.end(bytes);
  } catch {res.writeHead(404).end();}
});
await new Promise(resolve => testServer.listen(18765, '127.0.0.1', resolve));
const errors = [], external = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {last = await fn(); if (last) return;} catch (error) {last = error.message;}
    await pause(80);
  }
  throw new Error('Timed out waiting for browser state: ' + last);
}

try {
  const fixture = path.join(temp, 'staff.csv');
  await writeFile(fixture, 'email,name,department\n' + Array.from({length: 30000}, (_, i) => `staff${String(i).padStart(5, '0')}@example.com,Nhân sự ${i},Phòng ${i % 20}\n`).join(''));
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${path.join(temp, 'chrome')}`, `--remote-debugging-port=${debugPort}`, 'about:blank'], {stdio: 'ignore'});
  await waitFor(async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok);
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, {method: 'PUT'})).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {ws.onopen = resolve; ws.onerror = reject;});
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) task?.reject(new Error(JSON.stringify(message.error)));
      else task?.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    else if (message.method === 'Network.requestWillBeSent') {
      const url = message.params.request.url;
      if (/^https?:/.test(url) && !url.startsWith('http://127.0.0.1:18765/')) external.push(url);
    }
  };
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => {pending.delete(id); reject(new Error(`CDP timeout: ${method} ${JSON.stringify(params)}`));}, 15000);
      pending.set(id, {resolve: value => {clearTimeout(timeout); resolve(value);}, reject: error => {clearTimeout(timeout); reject(error);}});
      ws.send(JSON.stringify({id, method, params}));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function key(key, code = key, keyCode = key.charCodeAt(0)) {
    await cdp('Input.dispatchKeyEvent', {type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode});
    await cdp('Input.dispatchKeyEvent', {type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode});
  }
  async function screenshot(name) {
    await mkdir(path.join(root, '.test-artifacts'), {recursive: true});
    const image = await cdp('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
    await writeFile(path.join(root, '.test-artifacts', name), Buffer.from(image.data, 'base64'));
  }
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable', {maxPostDataSize: 0});
  await cdp('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false});
  const pickerStub = await cdp('Page.addScriptToEvaluateOnNewDocument', {source: `
    FileSystemDirectoryHandle.prototype.queryPermission = async () => sessionStorage.getItem('gala-test-permission') || 'granted';
    FileSystemDirectoryHandle.prototype.requestPermission = async () => sessionStorage.getItem('gala-test-request') || 'granted';
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      return root;
    };
  `});
  await cdp('Page.navigate', {url: 'http://127.0.0.1:18765/'});
  await waitFor(() => evaluate(`document.getElementById('environment-dialog').open`));
  await evaluate(`document.getElementById('choose-directory').click()`);
  await pause(500);
  console.log('Bootstrap:', await evaluate(`document.getElementById('environment-status').textContent`));
  await waitFor(() => evaluate(`document.getElementById('spin-status').textContent.includes('ĐẦU TIÊN')`));
  assert.equal(await evaluate(`document.body.classList.contains('stage-waiting') && document.getElementById('stage').inert && getComputedStyle(document.querySelector('.stage-tools')).visibility === 'hidden'`), true);
  await key('ArrowRight', 'ArrowRight', 39);
  await pause(650);
  assert.equal(await evaluate(`!document.getElementById('stage').inert && getComputedStyle(document.getElementById('stage')).opacity === '1'`), true);
  await key('ArrowLeft', 'ArrowLeft', 37);
  await pause(650);
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('stage')).visibility === 'hidden'`), true);
  await key(' ', 'Space', 32);
  await key('ArrowDown', 'ArrowDown', 40);
  await evaluate(`document.getElementById('show-setup').click()`);
  await key('ArrowUp', 'ArrowUp', 38);
  assert.equal(await evaluate(`!document.body.classList.contains('stage-waiting')`), true);
  assert.equal(await evaluate(`document.getElementById('import-button').disabled`), true);
  await evaluate(`document.getElementById('add-batch').click();document.getElementById('batch-name').value='Gala QA · 30.000 nhân sự';document.getElementById('create-batch-form').requestSubmit()`);
  await waitFor(() => evaluate(`!document.getElementById('import-button').disabled && document.getElementById('setup-batch').selectedOptions[0].textContent==='Gala QA · 30.000 nhân sự'`));
  assert.equal(await evaluate(`document.getElementById('stat-total').textContent==='0' && document.getElementById('spin').disabled && document.getElementById('create-batch-form').hidden`), true);
  const doc = await cdp('DOM.getDocument');
  const input = await cdp('DOM.querySelector', {nodeId: doc.root.nodeId, selector: '#import-file'});
  await cdp('DOM.setFileInputFiles', {nodeId: input.nodeId, files: [fixture]});
  // Avoid unnecessary debugger network payload collection during import.
  await cdp('Network.disable');
  await evaluate(`document.getElementById('import-form').requestSubmit()`);
  console.log('Import submitted');
  await waitFor(() => evaluate(`document.getElementById('stat-total').textContent.replace(/[^0-9]/g,'')==='30000'`), 20000);
  await waitFor(() => evaluate(`!document.getElementById('import-button').disabled`));
  await cdp('Network.enable', {maxPostDataSize: 0});
  assert.equal(await evaluate(`document.querySelectorAll('#people-body tr').length`), 50);
  console.log('PASS: Import 30,000 records in browser; only 50 rows rendered');
  await evaluate(`for (const id of ['setting-title','setting-subtitle','setting-prize','setting-buttonText']) document.getElementById(id).value='   '; document.getElementById('settings-form').requestSubmit()`);
  await waitFor(() => evaluate(`!document.getElementById('save-settings').disabled && document.querySelector('.hero').hidden && document.querySelector('.prize-label').hidden`));
  await cdp('Page.reload');
  await waitFor(() => evaluate(`document.querySelector('.hero').hidden && !document.getElementById('spin').disabled`));
  await key('ArrowDown', 'ArrowDown', 40);
  await pause(650);
  assert.equal(await evaluate(`document.getElementById('stage-title').hidden && document.getElementById('stage-subtitle').hidden && document.querySelector('.prize-label').hidden && document.getElementById('setting-title').value === '' && document.getElementById('spin').textContent === ''`), true);
  await evaluate(`document.getElementById('show-setup').click(); document.getElementById('setting-manualLayout').checked=true; for (const [key,value] of Object.entries({reelY:55,reelWidth:88,reelHeight:400,reelRadius:32,reelFont:54,buttonY:89,buttonWidth:420,buttonHeight:72,buttonRadius:24})) document.getElementById('setting-'+key).value=value; document.getElementById('setting-buttonTransparent').checked=true;document.getElementById('setting-buttonText').value='QUAY NGAY';document.getElementById('preview-layout').click()`);
  await pause(650);
  assert.equal(await evaluate(`(() => {const box=document.querySelector('.reel-shell').getBoundingClientRect(),button=document.getElementById('spin').getBoundingClientRect();return document.body.classList.contains('manual-layout') && Math.abs(box.width-innerWidth*.88)<2 && Math.abs(box.left+box.width/2-innerWidth*.5)<2 && Math.abs(box.top+box.height/2-innerHeight*.55)<2 && Math.abs(button.left+button.width/2-innerWidth*.5)<2 && Math.abs(button.top+button.height/2-innerHeight*.89)<2 && box.height===400 && button.width===420 && button.height===72 && getComputedStyle(document.querySelector('.reel-shell')).borderRadius==='32px' && getComputedStyle(document.querySelector('.card-name')).fontSize==='39px' && document.getElementById('spin').textContent==='QUAY NGAY' && getComputedStyle(document.querySelector('.mail')).fontSize==='54px';})()`), true);
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('spin')).backgroundColor==='rgba(0, 0, 0, 0)' && getComputedStyle(document.getElementById('spin')).borderTopWidth==='1px'`), true);
  await screenshot('stage-manual-layout.png');
  await evaluate(`document.getElementById('show-setup').click(); document.getElementById('settings-form').requestSubmit()`);
  await waitFor(() => evaluate(`!document.getElementById('save-settings').disabled`));
  await cdp('Page.reload');
  await waitFor(() => evaluate(`document.body.classList.contains('manual-layout') && !document.getElementById('spin').disabled`));
  assert.equal(await evaluate(`!document.getElementById('setting-reelX') && !document.getElementById('setting-buttonX') && !document.getElementById('setting-nameFont') && document.getElementById('setting-buttonTransparent').checked && document.body.classList.contains('transparent-spin') && document.getElementById('setting-reelHeight').value==='400' && document.getElementById('spin').textContent==='QUAY NGAY' && document.getElementById('setting-manualLayout').checked`), true);
  await key('ArrowDown', 'ArrowDown', 40);
  await pause(650);
  await evaluate(`document.getElementById('show-setup').click(); document.getElementById('reset-layout').click(); document.getElementById('settings-form').requestSubmit()`);
  await waitFor(() => evaluate(`!document.body.classList.contains('manual-layout') && !document.getElementById('save-settings').disabled`));
  await evaluate(`document.querySelector('#setup-dialog .close').click(); document.activeElement.blur()`);
  assert.equal(await evaluate(`!document.getElementById('setting-buttonTransparent').checked && !document.body.classList.contains('transparent-spin') && getComputedStyle(document.getElementById('spin')).backgroundColor !== 'rgba(0, 0, 0, 0)'`), true);
  console.log('PASS: Manual reel/button placement, transparent button preview, persistence and reset');
  await evaluate(`document.getElementById('show-setup').click();document.getElementById('setting-fitBackground').checked=true;document.getElementById('preview-layout').click()`);
  await pause(650);
  const assertFittedStage = async () => {
    assert.equal(await evaluate(`(() => {
      const stage=document.getElementById('stage').getBoundingClientRect(),reel=document.querySelector('.reel-shell').getBoundingClientRect(),button=document.getElementById('spin').getBoundingClientRect();
      const scale=Math.min(innerWidth/1920,innerHeight/stageDesignHeight);
      return document.body.classList.contains('fit-background') && getComputedStyle(document.body).backgroundSize==='contain' &&
        Math.abs(stage.width-1920*scale)<1 && Math.abs(stage.height-stageDesignHeight*scale)<1 &&
        Math.abs(stage.left-(innerWidth-stage.width)/2)<1 && Math.abs(stage.top-(innerHeight-stage.height)/2)<1 &&
        Math.abs((reel.top+reel.height/2-stage.top)/stage.height-.5)<.002 &&
        Math.abs((button.top+button.height/2-stage.top)/stage.height-.85)<.002 &&
        Math.abs(reel.width/stage.width-.9)<.002 && Math.abs(button.width-310*scale)<1 &&
        document.documentElement.scrollWidth<=innerWidth;
    })()`), true);
  };
  await assertFittedStage();
  await screenshot('stage-fitted-desktop.png');
  await cdp('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:false});
  await pause(150);
  await assertFittedStage();
  await screenshot('stage-fitted-mobile.png');
  await cdp('Emulation.setDeviceMetricsOverride', {width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await pause(150);
  await evaluate(`document.getElementById('show-setup').click();document.getElementById('settings-form').requestSubmit()`);
  await waitFor(() => evaluate(`!document.getElementById('save-settings').disabled`));
  await cdp('Page.reload');
  await waitFor(() => evaluate(`document.body.classList.contains('fit-background') && !document.getElementById('spin').disabled`));
  await key('ArrowDown', 'ArrowDown', 40);
  await pause(650);
  await assertFittedStage();
  await evaluate(`document.getElementById('show-setup').click();document.getElementById('reset-layout').click();document.getElementById('settings-form').requestSubmit()`);
  await waitFor(() => evaluate(`!document.body.classList.contains('fit-background') && !document.getElementById('save-settings').disabled`));
  await evaluate(`document.querySelector('#setup-dialog .close').click();document.activeElement.blur()`);
  console.log('PASS: Image-relative stage preview, desktop/mobile geometry, reload and reset');
  await evaluate(`(async () => {
    document.getElementById('show-setup').click();
    const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;
    for (const [id,color] of [['background-file','#0033aa'],['waiting-background-file','#aa3300']]) {
      canvas.getContext('2d').fillStyle=color;canvas.getContext('2d').fillRect(0,0,2,2);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve));const transfer=new DataTransfer();
      transfer.items.add(new File([blob],id+'.png',{type:'image/png'}));document.getElementById(id).files=transfer.files;
    }
    document.getElementById('settings-form').requestSubmit();
  })()`);
  await waitFor(() => evaluate(`!document.getElementById('save-settings').disabled && document.body.style.backgroundImage.includes('blob:')`));
  const drawBackground = await evaluate(`document.body.style.backgroundImage`);
  await evaluate(`document.querySelector('#setup-dialog .close').click();document.activeElement.blur()`);
  await evaluate(`applyLayout({...readLayout(),fitBackground:true})`);
  await waitFor(() => evaluate(`stageDesignHeight===1920`));
  await pause(650);
  await assertFittedStage();
  await screenshot('stage-fitted-square-background.png');
  await evaluate(`applyLayout(readLayout())`);
  await key('ArrowUp', 'ArrowUp', 38);
  assert.notEqual(await evaluate(`document.body.style.backgroundImage`), drawBackground);
  assert.equal(await evaluate(`(() => {const saved=state.waitingImage;state.waitingImage='';updateStageBackground();const fallback=document.body.style.backgroundImage;state.waitingImage=saved;updateStageBackground();return fallback;})()`), drawBackground);
  await cdp('Page.reload');
  await waitFor(() => evaluate(`!document.getElementById('spin').disabled && document.body.style.backgroundImage.includes('blob:')`));
  const waitingBackground = await evaluate(`document.body.style.backgroundImage`);
  await key('ArrowDown', 'ArrowDown', 40);
  assert.notEqual(await evaluate(`document.body.style.backgroundImage`), waitingBackground);
  await evaluate(`document.getElementById('show-setup').click();document.getElementById('remove-background').click();document.getElementById('settings-form').requestSubmit()`);
  await waitFor(() => evaluate(`!document.getElementById('save-settings').disabled && document.body.style.backgroundImage===''`));
  await evaluate(`document.querySelector('#setup-dialog .close').click();document.activeElement.blur()`);
  await key('ArrowUp', 'ArrowUp', 38);
  assert.equal(await evaluate(`document.body.style.backgroundImage.includes('blob:')`), true);
  await key('ArrowDown', 'ArrowDown', 40);
  await evaluate(`document.getElementById('show-setup').click();document.getElementById('remove-waiting-background').click();document.getElementById('settings-form').requestSubmit()`);
  await waitFor(() => evaluate(`!document.getElementById('save-settings').disabled`));
  await evaluate(`document.querySelector('#setup-dialog .close').click();document.activeElement.blur()`);
  await key('ArrowUp', 'ArrowUp', 38);
  assert.equal(await evaluate(`document.body.style.backgroundImage`), '');
  await key('ArrowDown', 'ArrowDown', 40);
  await pause(650);
  console.log('PASS: Independent waiting/draw backgrounds persist; draw falls back to color, not waiting image');
  await evaluate(`document.getElementById('show-setup').click(); document.getElementById('setting-subtitle').value='GALA DINNER · LUCKY DRAW'; document.getElementById('settings-form').requestSubmit()`);
  await waitFor(() => evaluate(`!document.getElementById('save-settings').disabled && !document.querySelector('.hero').hidden && !document.getElementById('stage-subtitle').hidden`));
  assert.equal(await evaluate(`document.getElementById('stage-title').hidden && document.querySelector('.prize-label').hidden`), true);
  await evaluate(`document.getElementById('people-search').value='staff29999';document.getElementById('people-search').dispatchEvent(new Event('input'))`);
  await waitFor(() => evaluate(`document.querySelectorAll('#people-body tr').length===1 && document.getElementById('people-body').textContent.includes('staff29999')`));
  await evaluate(`document.getElementById('setting-title').value='ĐÊM GALA KIỂM THỬ';document.getElementById('setting-prize').value='GIẢI ĐẶC BIỆT';document.getElementById('setting-duration').value='3';document.getElementById('settings-form').requestSubmit()`);
  await waitFor(() => evaluate(`document.getElementById('stage-title').textContent==='ĐÊM GALA KIỂM THỬ'`));
  await waitFor(() => evaluate(`!document.getElementById('save-settings').disabled`));
  assert.equal(await evaluate(`!document.getElementById('stage-title').hidden && !document.querySelector('.prize-label').hidden`), true);
  await evaluate(`document.querySelector('#setup-dialog .close').click();document.activeElement.blur()`);
  await screenshot('stage-desktop.png');
  assert.equal(await evaluate(`document.getElementById('spin-status').hidden && !document.querySelector('.spin-controls p')`), true);
  assert.equal(await evaluate(`(() => {
    const card = document.querySelector('.stage-card');
    const style = getComputedStyle(card);
    return style.backdropFilter === 'none' &&
      ['stage-title', 'spin'].every(id => card.contains(document.getElementById(id))) &&
      !card.contains(document.querySelector('footer'));
  })()`), true);
  assert.equal(await evaluate(`(() => {
    const card = document.querySelector('.stage-card');
    const before = getComputedStyle(card).backgroundColor;
    const root = document.documentElement;
    const accent = root.style.getPropertyValue('--accent');
    root.style.setProperty('--accent', '#427de0');
    const after = getComputedStyle(card).backgroundColor;
    root.style.setProperty('--accent', accent);
    return before === 'rgba(0, 0, 0, 0)' && before === after;
  })()`), true);
  assert.equal(await evaluate(`document.getElementById('spin').textContent.trim()`), 'QUAY MAY MẮN');
  assert.equal(await evaluate(`document.querySelector('.stats').hidden && getComputedStyle(document.querySelector('.stats')).display === 'none'`), true);
  assert.equal(await evaluate(`!document.querySelector('.topbar') && !document.querySelector('.brand') && getComputedStyle(document.querySelector('.stage-tools')).position === 'fixed'`), true);
  assert.equal(await evaluate(`(() => {const box = document.querySelector('.stage-card').getBoundingClientRect();return Math.abs(box.top + box.height / 2 - innerHeight / 2) < 2;})()`), true);
  await cdp('Runtime.evaluate', {expression: `document.getElementById('fullscreen').click()`, userGesture: true});
  await waitFor(() => evaluate(`!!document.fullscreenElement && document.getElementById('fullscreen').getAttribute('aria-pressed') === 'true'`));
  await key('ArrowUp', 'ArrowUp', 38);
  await pause(650);
  assert.equal(await evaluate(`!!document.fullscreenElement && document.getElementById('stage').inert && getComputedStyle(document.getElementById('stage')).visibility === 'hidden'`), true);
  await key('ArrowDown', 'ArrowDown', 40);
  await pause(650);
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('show-setup')).display === 'none' && getComputedStyle(document.getElementById('show-winners')).display !== 'none' && getComputedStyle(document.getElementById('fullscreen')).display !== 'none' && document.getElementById('fullscreen').getAttribute('aria-pressed') === 'true'`), true);
  await evaluate(`document.getElementById('show-winners').click()`);
  await waitFor(() => evaluate(`document.getElementById('winners-dialog').open`));
  assert.equal(await evaluate(`!!document.fullscreenElement`), true);
  await evaluate(`document.querySelector('#winners-dialog .close').click()`);
  await cdp('Runtime.evaluate', {expression: `document.getElementById('fullscreen').click()`, userGesture: true});
  await waitFor(() => evaluate(`!document.fullscreenElement`));
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('show-setup')).display !== 'none' && getComputedStyle(document.getElementById('show-winners')).display !== 'none'`), true);
  await evaluate(`document.activeElement.blur()`);
  assert.equal(await evaluate(`!document.getElementById('lever') && !document.querySelector('.machine-heading')`), true);
  assert.equal(await evaluate(`!document.body.style.backgroundImage.includes('linear-gradient')`), true);
  console.log('PASS: Transparent stage without backdrop blur, machine header or lever');
  assert.equal(await evaluate(`(() => {
    const lens = document.querySelector('.center-frame'), style = getComputedStyle(lens);
    const box = lens.getBoundingClientRect(), shell = document.querySelector('.reel-shell').getBoundingClientRect();
    return style.backdropFilter === 'none' && style.pointerEvents === 'none' &&
      Math.abs(box.left - shell.left - 1) < 1 && Math.abs(shell.right - box.right - 1) < 1 &&
      getComputedStyle(document.querySelector('.email-card')).backdropFilter === 'none';
  })()`), true);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.email-card .mail')).color`), 'rgb(248, 247, 243)');
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
  assert.equal(await evaluate(`['.reel-shell', '.email-card', '.center-frame', '.reel-shade'].every(selector => {const style = getComputedStyle(document.querySelector(selector)); return style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.backgroundImage === 'none';})`), true);
  assert.equal(await evaluate(`(() => {const frame=getComputedStyle(document.querySelector('.center-frame'));return frame.borderTopWidth==='0px' && frame.borderBottomWidth==='0px' && !document.querySelector('.notch');})()`), true);
  console.log('PASS: Transparent reel, no winner lines or arrows, readable light text, no reel blur filters');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.reel-shell')).borderTopLeftRadius`), '20px');
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('reel-track')).flexDirection`), 'column');
  assert.equal(await evaluate(`/[✦✧★☆]/.test(document.body.textContent)`), false);
  await evaluate(`window.reelStartY = new DOMMatrixReadOnly(getComputedStyle(document.getElementById('reel-track')).transform).m42`);
  await key(' ', 'Space', 32);
  await waitFor(() => evaluate(`document.querySelectorAll('.email-card').length === 66 && Number(document.getElementById('reel-track').dataset.position) < 60`));
  assert.equal(await evaluate(`reelAudio.state === 'running' && Number.isFinite(lastReelTick)`), true);
  assert.equal(await evaluate(`document.querySelectorAll('#spin .button-ripple').length===3 && parseFloat(document.querySelector('.button-ripple').style.left)===document.getElementById('spin').clientWidth/2`), true);
  assert.equal(await evaluate(`(() => {const notes=[...document.querySelectorAll('.button-note')],button=document.getElementById('spin'),box=button.getBoundingClientRect();return notes.length===18 && new Set(notes.map(note=>note.style.color)).size===6 && notes.every(note=>{const x=parseFloat(note.style.left),y=parseFloat(note.style.top);return !button.contains(note) && (x<box.left || x>box.right || y<box.top || y>box.bottom);}) && getComputedStyle(document.querySelector('.button-notes')).pointerEvents==='none';})()`), true);
  const movingY = await evaluate(`new DOMMatrixReadOnly(getComputedStyle(document.getElementById('reel-track')).transform).m42`);
  await pause(100);
  assert.equal(await evaluate(`new DOMMatrixReadOnly(getComputedStyle(document.getElementById('reel-track')).transform).m42 > ${movingY}`), true);
  await waitFor(() => evaluate(`document.getElementById('winner-dialog').open`));
  await waitFor(() => evaluate(`!document.getElementById('winner-sound').paused && document.getElementById('winner-sound').currentTime > 0`));
  assert.equal(await evaluate(`document.getElementById('winner-sound').currentSrc.endsWith('/app/src/sounds/winner.mp3') && !document.getElementById('winner-sound').loop`), true);
  assert.equal(await evaluate(`document.querySelectorAll('.button-ripple').length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('.button-notes').length`), 0);
  assert.equal(await evaluate(`!document.querySelector('.winner-congrats') && !document.getElementById('winner-dialog').textContent.includes('Kết quả đã được lưu')`), true);
  assert.equal(await evaluate(`!document.querySelector('.winner-seal') && !document.getElementById('winner-prize') && !document.getElementById('winner-dialog').textContent.includes('THE SPOTLIGHT IS YOURS')`), true);
  assert.equal(await evaluate(`parseFloat(getComputedStyle(document.getElementById('winner-department')).fontSize) >= 22 && getComputedStyle(document.getElementById('winner-department')).fontWeight === '800'`), true);
  assert.equal(await evaluate(`document.querySelectorAll('.email-card').length`), 66);
  assert.equal(await evaluate(`document.getElementById('stat-won').textContent`), '1');
  const firstEmail = await evaluate(`document.getElementById('winner-email').textContent`);
  assert.equal(await evaluate(`(() => {
    const track = document.getElementById('reel-track');
    const card = track.children[Number(track.dataset.position)];
    const box = card.getBoundingClientRect(), frame = document.querySelector('.center-frame').getBoundingClientRect();
    return Math.abs(box.y + box.height / 2 - frame.y - frame.height / 2) < 1 &&
      card.querySelector('.mail').textContent === document.getElementById('winner-email').textContent &&
      new DOMMatrixReadOnly(getComputedStyle(track).transform).m41 === 0;
  })()`), true);
  console.log('PASS: No decorative stars; vertical reel moves down and winning email stops exactly on payline');
  await screenshot('winner-desktop.png');
  await key('v', 'KeyV', 86);
  await waitFor(() => evaluate(`!document.getElementById('winner-dialog').open && !document.getElementById('spin').disabled`));
  assert.equal(await evaluate(`document.getElementById('winner-sound').paused && document.getElementById('winner-sound').currentTime === 0`), true);
  console.log('PASS: SPACE spin, bounded reel, winner popup, V absent and close');
  await evaluate(`(() => {const button=document.getElementById('spin'),box=button.getBoundingClientRect();document.body.classList.add('transparent-spin');button.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1,clientX:box.left+40,clientY:box.top+20}));})()`);
  assert.equal(await evaluate(`document.querySelectorAll('#spin .button-ripple').length===3 && Math.abs(parseFloat(document.querySelector('.button-ripple').style.left)-39)<1 && getComputedStyle(document.getElementById('spin')).backgroundColor==='rgba(0, 0, 0, 0)'`), true);
  assert.equal(await evaluate(`document.querySelectorAll('.button-note').length`), 18);
  await evaluate(`document.activeElement.blur()`);
  await waitFor(() => evaluate(`document.getElementById('winner-dialog').open`));
  assert.notEqual(await evaluate(`document.getElementById('winner-email').textContent`), firstEmail);
  await key(' ', 'Space', 32);
  await waitFor(() => evaluate(`!document.getElementById('winner-dialog').open && !document.getElementById('spin').disabled`));
  await pause(150);
  await evaluate(`document.body.classList.remove('transparent-spin')`);
  assert.equal(await evaluate(`document.getElementById('stat-won').textContent`), '2');
  await evaluate(`document.getElementById('show-winners').click()`);
  await waitFor(() => evaluate(`document.querySelectorAll('.winner-item').length===2`));
  assert.equal(await evaluate(`document.querySelectorAll('.winner-item .absent').length`), 1);
  console.log('PASS: Next SPACE starts new spin; next SPACE only closes; absence shown in history');
  await screenshot('winners-desktop.png');
  await evaluate(`document.querySelector('#winners-dialog .close').click();document.activeElement.blur()`);
  // Reload during an active draw and ensure replay does not create a fourth winner.
  await key(' ', 'Space', 32);
  await waitFor(() => evaluate(`document.getElementById('stat-won').textContent==='3'`));
  const settingsBeforeReload = await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    const settings = await (await root.getDirectoryHandle('src')).getDirectoryHandle('setting');
    const broken = await settings.getFileHandle('20200101_deadbeef.json', {create:true});
    const writer = await broken.createWritable();
    await writer.write(JSON.stringify({directory:'src/data/missing-old-batch'}));
    await writer.close();
    const names = [];
    for await (const [name] of settings.entries()) names.push(name);
    return names.sort();
  })()`);
  await cdp('Page.reload');
  await waitFor(() => evaluate(`document.getElementById('stat-won').textContent==='3' && !document.getElementById('spin').disabled`));
  await key('ArrowRight', 'ArrowRight', 39);
  await pause(650);
  assert.deepEqual(await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    const settings = await (await root.getDirectoryHandle('src')).getDirectoryHandle('setting');
    const names = [];
    for await (const [name] of settings.entries()) names.push(name);
    return names.sort();
  })()`), settingsBeforeReload);
  console.log('PASS: Reload creates no additional settings files and leaves no write-probe file');
  assert.equal(await evaluate(`document.getElementById('batch-warning').hidden`), true);
  assert.equal(await evaluate(`!document.querySelector('#stage select') && !document.getElementById('batch-select')`), true);
  await evaluate(`document.getElementById('show-setup').click()`);
  const healthyId = await evaluate(`document.getElementById('setup-batch').value`);
  await evaluate(`document.getElementById('setup-batch').value='20200101_deadbeef'; document.getElementById('setup-batch').dispatchEvent(new Event('change'))`);
  await waitFor(() => evaluate(`!document.getElementById('batch-warning').hidden && document.getElementById('spin').disabled`));
  assert.equal(await evaluate(`document.getElementById('batch-warning-detail').textContent.includes('src/data/missing-old-batch')`), true);
  assert.equal(await evaluate(`document.getElementById('setup-batch').value`), '20200101_deadbeef');
  await evaluate(`document.getElementById('setup-batch').value=${JSON.stringify(healthyId)}; document.getElementById('setup-batch').dispatchEvent(new Event('change'))`);
  await waitFor(() => evaluate(`!document.getElementById('spin').disabled && document.getElementById('batch-warning').hidden`));
  assert.equal(await evaluate(`document.querySelectorAll('#setup-batch option').length`), 2);
  assert.equal(await evaluate(`document.getElementById('stage-title').textContent === 'ĐÊM GALA KIỂM THỬ' && localStorage.getItem('gala-batch') === document.getElementById('setup-batch').value`), true);
  await evaluate(`document.querySelector('#setup-dialog .close').click(); document.activeElement.blur()`);
  console.log('PASS: Only selected broken batch shows warning; healthy selection restores draw and pending result');
  assert.equal(await evaluate(`document.getElementById('environment-dialog').open`), false);
  console.log('PASS: IndexedDB directory handle restores automatically without folder picker');
  await key(' ', 'Space', 32);
  await waitFor(() => evaluate(`document.body.classList.contains('winner-highlight')`));
  assert.equal(await evaluate(`(() => {
    const frame = document.querySelector('.center-frame');
    const animation = frame.getAnimations()[0];
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const probe = document.createElement('span'); probe.style.backgroundColor = accent;
    document.body.append(probe); const color = getComputedStyle(probe).backgroundColor; probe.remove();
    return !document.getElementById('winner-dialog').open && document.getElementById('spin').disabled &&
      animation.effect.getTiming().iterations === 3 && animation.effect.getKeyframes()[1].backgroundColor === color &&
      ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'].every(key => getComputedStyle(frame)[key] === '30px');
  })()`), true);
  await waitFor(() => evaluate(`document.getElementById('winner-dialog').open`));
  assert.equal(await evaluate(`!document.body.classList.contains('winner-highlight') && getComputedStyle(document.querySelector('.center-frame')).backgroundColor === 'rgba(0, 0, 0, 0)'`), true);
  assert.equal(await evaluate(`document.getElementById('stat-won').textContent`), '3');
  await key(' ', 'Space', 32);
  await waitFor(() => evaluate(`!document.getElementById('winner-dialog').open && !document.getElementById('spin').disabled`));
  console.log('PASS: Reload mid-spin restores same persisted result, no duplicate award');
  await cdp('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: false});
  await screenshot('stage-mobile.png');
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
  assert.equal(await evaluate(`(() => {
    const track = document.getElementById('reel-track'), card = track.children[Number(track.dataset.position)];
    const box = card.getBoundingClientRect(), frame = document.querySelector('.center-frame').getBoundingClientRect();
    return Math.abs(box.y + box.height / 2 - frame.y - frame.height / 2) < 1;
  })()`), true);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  console.log('PASS: Mobile has no horizontal overflow; no external requests; no uncaught JS errors');
  const codec = await evaluate(`(async () => {
    const blob = await GalaStorage.exportBatch(document.getElementById('setup-batch').value, false);
    const rows = await GalaExcel.readRows(new File([blob], 'roundtrip.xlsx'));
    if (rows.length !== 30001) throw new Error('Excel roundtrip count');
    const imported = await GalaExcel.people(new File([blob], 'roundtrip.xlsx'));
    if (imported.people.length !== 30000) throw new Error('Excel reimport count');
    if (rows[0].slice(0, 4).join('|') !== 'Mã nhân viên|Tên nhân viên|Email công ty|Phòng ban') throw new Error('Export column order');
    const stats = (await GalaStorage.route('/api/batches'))[0];
    return {rows: rows.length, won: stats.won};
  })()`);
  assert.equal(codec.rows, 30001); assert.equal(codec.won, 3);
  console.log('PASS: XLSX export/read/import 30,000 rows and persisted OPFS logs survive reload');
  const newTemplate = await evaluate(`(async () => {
    const blob = await GalaExcel.write(GalaExcel.templateRows);
    const file = new File([blob], 'template.xlsx');
    const rows = await GalaExcel.readRows(file);
    const parsed = await GalaExcel.people(file);
    const csv = await GalaExcel.people(new File(['Mã nhân viên,Tên nhân viên,Email công ty,Phòng ban\\n000123,Nguyễn Văn B,b@example.com,Kế toán'], 'new.csv'));
    return {headers: rows[0], person: parsed.people[0], csv: csv.people[0]};
  })()`);
  assert.deepEqual(newTemplate.headers, ['Mã nhân viên', 'Tên nhân viên', 'Email công ty', 'Phòng ban']);
  assert.equal(newTemplate.person.employeeCode, 'NV0001');
  assert.equal(newTemplate.person.name, 'Nguyễn Văn A');
  assert.equal(newTemplate.person.email, 'nguyenvan.a@example.com');
  assert.equal(newTemplate.person.department, 'Kinh doanh');
  assert.equal(newTemplate.csv.employeeCode, '000123');
  assert.equal(await evaluate(`makeCard(${JSON.stringify(newTemplate.csv)}).querySelector('.card-name').textContent`), 'Nguyễn Văn B - 000123');
  assert.equal(await evaluate(`makeCard({email:'old@example.com',name:'Nhân viên cũ'}).querySelector('.card-name').textContent`), 'Nhân viên cũ');
  assert.equal(await evaluate(`makeCard({email:'code@example.com',employeeCode:'000123'}).querySelector('.card-name').textContent`), '000123');
  assert.equal(await evaluate(`makeCard({email:'empty@example.com'}).querySelector('.card-name').textContent`), 'NGƯỜI MAY MẮN TIẾP THEO');
  const sampleBase64 = (await readFile(path.join(root, 'samples/nhan-su-mau-1000.xlsx'))).toString('base64');
  const sample = await evaluate(`GalaExcel.people(new File([Uint8Array.from(atob(${JSON.stringify(sampleBase64)}), c => c.charCodeAt(0))], 'sample.xlsx'))`);
  assert.equal(sample.people.length, 1000);
  assert.equal(sample.people[0].employeeCode, 'NV0001');
  assert.equal(sample.people[999].employeeCode, 'NV1000');
  console.log('PASS: Vietnamese four-column template, employee codes with leading zeros, 1,000-person sample');
  const compressed = compressedWorkbook().toString('base64');
  const imported = await evaluate(`GalaExcel.people(new File([Uint8Array.from(atob(${JSON.stringify(compressed)}), c => c.charCodeAt(0))], 'compressed.xlsx'))`);
  assert.equal(imported.people[0].email, 'user@example.com');
  assert.equal(imported.people[0].name, 'Nguyễn Văn A');
  assert.deepEqual(imported.report, {accepted: 1, duplicates: 1, invalid: 1});
  console.log('PASS: Deflated XLSX, shared strings/rich text, first-sheet relation, duplicate/invalid rows');
  await evaluate(`document.getElementById('show-setup').click();window.originalConfirm=window.confirm;window.confirm=message=>{window.resetWarning=message;return false;}; const transfer=new DataTransfer();transfer.items.add(new File(['Mã nhân viên,Tên nhân viên,Email công ty,Phòng ban\\n0001,Nhân viên mới,new@example.com,IT'],'replacement.csv'));document.getElementById('import-file').files=transfer.files;document.getElementById('import-form').requestSubmit()`);
  assert.equal(await evaluate(`window.resetWarning.includes('3 người trúng') && document.getElementById('stat-won').textContent==='3'`), true);
  await evaluate(`window.confirm=()=>true;document.getElementById('import-form').requestSubmit()`);
  await waitFor(() => evaluate(`document.getElementById('stat-total').textContent==='1' && document.getElementById('stat-won').textContent==='0' && !document.getElementById('import-button').disabled`));
  assert.equal(await evaluate(`document.getElementById('people-body').textContent.includes('new@example.com') && document.getElementById('stage-title').textContent==='ĐÊM GALA KIỂM THỬ' && localStorage.getItem('gala-pending')===null`), true);
  await evaluate(`window.confirm=window.originalConfirm;document.querySelector('#setup-dialog .close').click();document.activeElement.blur()`);
  console.log('PASS: Replacement warns for existing winners; cancel preserves data; confirm resets roster and results');
  await evaluate(`sessionStorage.setItem('gala-test-permission', 'prompt'); sessionStorage.setItem('gala-test-request', 'denied')`);
  await cdp('Page.reload');
  await waitFor(() => evaluate(`document.getElementById('environment-dialog').open && document.getElementById('choose-directory').textContent.includes('Cho phép dùng lại')`));
  await evaluate(`window.showDirectoryPicker = async () => {throw new Error('Picker must not open on remembered-folder retry');}; document.getElementById('choose-directory').click()`);
  await waitFor(() => evaluate(`document.getElementById('environment-status').textContent.includes('Chưa có quyền')`));
  assert.equal(await evaluate(`document.getElementById('spin').disabled`), true);
  await evaluate(`sessionStorage.setItem('gala-test-request', 'granted'); document.getElementById('choose-directory').click()`);
  await waitFor(() => evaluate(`document.getElementById('stat-won').textContent === '0' && document.getElementById('stat-total').textContent === '1' && !document.getElementById('environment-dialog').open`));
  console.log('PASS: Remembered handle requests permission on click, denial blocks draws, retry succeeds without picker');
  await cdp('Page.removeScriptToEvaluateOnNewDocument', {identifier: pickerStub.identifier});
  await cdp('Page.navigate', {url: 'file://' + path.join(root, '..', 'index.html')});
  await waitFor(() => evaluate(`document.getElementById('environment-dialog').open`));
  assert.equal(await evaluate(`isSecureContext && typeof showDirectoryPicker === 'function' && !document.getElementById('choose-directory').disabled`), true);
  assert.equal(await evaluate(`document.getElementById('environment-title').textContent`), 'Chọn thư mục lưu dữ liệu');
  await evaluate(`window.showDirectoryPicker = async () => {throw new DOMException('cancelled', 'AbortError');}; document.getElementById('choose-directory').click()`);
  await waitFor(() => evaluate(`document.getElementById('environment-status').textContent.includes('chưa chọn thư mục')`));
  assert.equal(await evaluate(`document.getElementById('environment-dialog').open && document.getElementById('spin').disabled`), true);
  assert.deepEqual(errors, []);
  console.log('PASS: Direct file:// bootstrap loads with native picker capability; cancel keeps drawing blocked');
  console.log('Screenshots: ' + path.join(root, '.test-artifacts'));
} finally {
  ws?.close();
  browser?.kill();
  await new Promise(resolve => testServer.close(resolve));
  await pause(400);
  await rm(temp, {recursive: true, force: true});
}