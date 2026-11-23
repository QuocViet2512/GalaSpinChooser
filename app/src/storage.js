'use strict';
window.GalaStorage = (() => {
  const defaults = {title: 'ĐÊM CỦA NHỮNG NGÔI SAO', subtitle: 'GALA DINNER · LUCKY DRAW', prize: 'PHẦN QUÀ MAY MẮN', accent: '#ff823f', backgroundColor: '#101114', background: '', duration: 7};
  const random = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
  const layoutDefaults = {waitingBackground: '', manualLayout: false, fitBackground: false, reelY: 50, reelWidth: 90, reelHeight: 360, reelRadius: 20, reelFont: 42, buttonY: 85, buttonWidth: 310, buttonHeight: 58, buttonRadius: 10, buttonTransparent: false, buttonText: 'QUAY MAY MẮN'};
  Object.assign(defaults, layoutDefaults, {buttonBackground: '', reelBackground: '', winnerBackground: '', winnerWidth: 780, winnerHeight: 400, winnerContentY: 50, winnerTransparent: false, winnerTextColor: '#ffffff', reelTextColor: '#ffffff', reelBorder: true});
  function randomIndex(length) {
    const bound = Math.floor(4294967296 / length) * length, value = new Uint32Array(1);
    do {crypto.getRandomValues(value);} while (value[0] >= bound);
    return value[0] % length;
  }
  let root, generation = 0, active = false;
  const cache = new Map(), urls = new Map();
  let batchErrors = [];
  async function directory(path, create = false) {
    if (!root) throw new Error('Chưa chọn thư mục lưu dữ liệu.');
    const parts = path.split('/').filter(Boolean);
    if (parts.some(p => p === '..' || p === '.')) throw new Error('Đường dẫn dữ liệu không hợp lệ.');
    let handle = root;
    for (const part of parts) handle = await handle.getDirectoryHandle(part, {create});
    return handle;
  }
  async function file(path, create = false) {
    const parts = path.split('/'), name = parts.pop();
    return (await directory(parts.join('/'), create)).getFileHandle(name, {create});
  }
  async function read(path, optional = false) {
    try {return await (await (await file(path)).getFile()).text();}
    catch (error) {
      if (optional && error.name === 'NotFoundError') return '';
      throw new Error(`Không đọc được ${path}: ${error.message}`);
    }
  }
  async function write(path, value) {
    const handle = await file(path, true);
    const stream = await handle.createWritable();
    try {await stream.write(value); await stream.close();}
    catch (error) {await stream.abort().catch(() => {}); throw new Error(`Không ghi được ${path}: ${error.message}`);}
  }
  async function exclusive(fn) {
    if (active) throw new Error('Đang xử lý ghi dữ liệu. Vui lòng chờ.');
    active = true;
    try {return await fn();} finally {active = false;}
  }
  async function attach(handle) {
    if (active) throw new Error('Không đổi thư mục khi đang ghi.');
    root = handle; generation++; cache.clear();
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
    await directory('src/setting', true);
    const probe = `src/setting/.gala-write-test-${random(4)}`;
    await write(probe, 'Gala Spin writable');
    await (await directory('src/setting')).removeEntry(probe.split('/').pop());
    return handle.name;
  }
  async function load(id) {
    if (!/^\d{8}_[a-z0-9]{8}$/.test(id)) throw new Error('Mã đợt không hợp lệ.');
    if (cache.has(id)) return cache.get(id);
    const config = JSON.parse(await read(`src/setting/${id}.json`));
    const people = JSON.parse(await read(`${config.directory}/people.json`));
    if (!Array.isArray(people) || people.some((p, i) => p.id !== i || typeof p.email !== 'string')) throw new Error('people.json không đúng định dạng.');
    const wins = new Map(), requests = new Map(), byPerson = new Map();
    const log = await read(`${config.directory}/events.jsonl`, true);
    const lines = log.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      let event;
      try {event = JSON.parse(lines[i]);}
      catch {throw new Error('Log bị lỗi. Dừng quay và khôi phục bản sao, không tự xóa log.');}
      if (event.type === 'draw') {
        if (!people[event.personId] || wins.has(event.id) || byPerson.has(event.personId) || requests.has(event.requestId)) throw new Error('Log trúng bị trùng/hỏng.');
        wins.set(event.id, event); requests.set(event.requestId, event); byPerson.set(event.personId, event);
      } else if (event.type === 'absent' && wins.has(event.id)) wins.get(event.id).absent = true;
      else throw new Error('Loại bản ghi log không hợp lệ.');
    }
    config.settings = {...defaults, ...config.settings, reelTextColor: config.settings?.reelTextColor ?? config.settings?.winnerTextColor ?? defaults.reelTextColor};
    config.settings.reelFont = Math.max(26, config.settings.reelFont);
    delete config.settings.reelX; delete config.settings.buttonX; delete config.settings.nameFont;
    const data = {config, people, wins, requests, byPerson, pool: people.filter(p => !byPerson.has(p.id)).map(p => p.id)};
    cache.set(id, data);
    return data;
  }
  const summary = data => ({...data.config, total: data.people.length, remaining: data.pool.length, won: data.wins.size});
  const result = (data, event) => ({...event, person: data.people[event.personId], remaining: data.pool.length});
  async function append(data, event) {
    const path = `${data.config.directory}/events.jsonl`, handle = await file(path, true);
    const existing = await handle.getFile(), stream = await handle.createWritable({keepExistingData: true});
    try {
      await stream.seek(existing.size);
      let prefix = '';
      if (existing.size && (await existing.slice(-1).text()) !== '\n') prefix = '\n';
      await stream.write(prefix + JSON.stringify(event) + '\n');
      await stream.close();
    } catch (error) {
      await stream.abort().catch(() => {});
      cache.delete(data.config.id);
      throw new Error(`Chưa xác nhận lưu log: ${error.message}. Chọn quay lại để khôi phục cùng lượt.`);
    }
  }
  async function background(path) {
    if (!path) return '';
    if (urls.has(path)) return urls.get(path);
    if (!/^\/?src\/images\/[a-f0-9]+\.(png|jpg|webp)$/.test(path)) throw new Error('Ảnh nền không hợp lệ.');
    const blob = await (await file(path.replace(/^\//, ''))).getFile();
    const url = URL.createObjectURL(blob); urls.set(path, url); return url;
  }
  async function create(name, imported) {
    const {people, report} = imported ? await GalaExcel.people(imported) : {people: [], report: {accepted: 0, duplicates: 0, invalid: 0}};
    const date = new Date(), pad = n => String(n).padStart(2, '0'), suffix = random(4);
    const id = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${suffix}`;
    const path = `src/data/${date.getFullYear()}_${pad(date.getMonth() + 1)}_${pad(date.getDate())}_${suffix}`;
    if (imported) await write(`${path}/original.${imported.name.split('.').pop().toLowerCase()}`, imported);
    await write(`${path}/people.json`, JSON.stringify(people));
    const config = {id, name: String(name).trim().slice(0, 120) || 'Đợt quay mới', directory: path, createdAt: date.toISOString(), settings: {...defaults}, importReport: report};
    await write(`src/setting/${id}.json`, JSON.stringify(config));
    return summary(await load(id));
  }
  async function route(path, input, signal) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const url = new URL(path, 'https://local.invalid');
    if (url.pathname === '/api/batches') {
      if (input) return exclusive(() => create(input.name, input.file));
      const configs = [];
      for await (const [name, handle] of (await directory('src/setting', true)).entries()) {
        if (handle.kind === 'file' && /^\d{8}_[a-z0-9]{8}\.json$/.test(name)) configs.push(name.slice(0, -5));
      }
      const batches = [];
      batchErrors = [];
      for (const id of configs.sort().reverse()) {
        try {batches.push(summary(await load(id)));}
        catch (error) {batchErrors.push({id, message: error.message});}
      }
      return batches;
    }
    if (url.pathname === '/api/background') return exclusive(async () => {
      const image = input.file;
      if (image.size > 10_000_000) throw new Error('Ảnh nền tối đa 10 MB.');
      const bytes = new Uint8Array(await image.slice(0, 12).arrayBuffer());
      const ext = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 ? 'png' : bytes[0] === 255 && bytes[1] === 216 ? 'jpg' : new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP' ? 'webp' : null;
      if (!ext) throw new Error('Chỉ nhận PNG, JPG, WebP.');
      const path = `/src/images/${random(12)}.${ext}`;
      await write(path.slice(1), image); return {url: path};
    });
    const match = /^\/api\/batches\/([^/]+)\/(stage|people|winners|draw|absent|settings|import)$/.exec(url.pathname);
    if (!match) throw new Error('Thao tác không hợp lệ.');
    const [, id, action] = match;
    const execute = async () => {
      const data = await load(id);
      if (action === 'import') {
        if (!input?.file) throw new Error('Hãy chọn file danh sách nhân sự.');
        if (data.wins.size && input.confirmReset !== true) throw new Error('Đợt này đã có người trúng. Cần xác nhận xóa kết quả trước khi thay dữ liệu.');
        const {people, report} = await GalaExcel.people(input.file);
        // Commit the new configuration last: failed writes leave the active dataset intact.
        const date = new Date(), pad = n => String(n).padStart(2, '0');
        const path = `src/data/${date.getFullYear()}_${pad(date.getMonth() + 1)}_${pad(date.getDate())}_${random(4)}`;
        await write(`${path}/original.${input.file.name.split('.').pop().toLowerCase()}`, input.file);
        await write(`${path}/people.json`, JSON.stringify(people));
        await write(`${path}/events.jsonl`, '');
        const config = {...data.config, directory: path, importReport: report};
        await write(`src/setting/${id}.json`, JSON.stringify(config));
        cache.delete(id);
        return summary(await load(id));
      }
      if (action === 'stage') return {batch: summary(data), sample: Array.from({length: Math.min(80, data.pool.length)}, () => data.people[data.pool[randomIndex(data.pool.length)]])};
      if (action === 'winners') return Array.from(data.wins.values()).reverse().map(win => result(data, win));
      if (action === 'draw') {
        if (!/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId)) throw new Error('Request ID không hợp lệ.');
        if (data.requests.has(input.requestId)) return result(data, data.requests.get(input.requestId));
        if (!data.pool.length) throw new Error('Đợt này đã hết người chưa trúng.');
        const index = randomIndex(data.pool.length), personId = data.pool[index];
        const win = {type: 'draw', id: random(12), personId, requestId: input.requestId, prize: String(input.prize || data.config.settings.prize).slice(0, 200), at: new Date().toISOString(), absent: false};
        await append(data, win);
        data.pool[index] = data.pool[data.pool.length - 1]; data.pool.pop();
        data.wins.set(win.id, win); data.requests.set(win.requestId, win); data.byPerson.set(personId, win);
        return result(data, win);
      }
      if (action === 'absent') {
        const win = data.wins.get(input.winId);
        if (!win) throw new Error('Không tìm thấy người trúng.');
        if (!win.absent) {await append(data, {type: 'absent', id: win.id, at: new Date().toISOString()}); win.absent = true;}
        return result(data, win);
      }
      if (action === 'settings') {
        const settings = {...defaults};
        for (const key of ['title', 'subtitle', 'prize']) settings[key] = String(input[key] ?? defaults[key]).trim().slice(0, 200);
        for (const key of ['accent', 'backgroundColor']) {
          if (!/^#[a-f0-9]{6}$/i.test(input[key])) throw new Error('Màu không hợp lệ.');
          settings[key] = input[key];
        }
        settings.duration = Math.max(3, Math.min(20, Number(input.duration) || 7));
        settings.background = input.background || '';
        settings.waitingBackground = input.waitingBackground ?? data.config.settings.waitingBackground ?? '';
        settings.buttonBackground = input.buttonBackground ?? data.config.settings.buttonBackground ?? '';
        settings.reelBackground = input.reelBackground ?? data.config.settings.reelBackground ?? '';
        settings.winnerBackground = input.winnerBackground ?? data.config.settings.winnerBackground ?? '';
        settings.manualLayout = input.manualLayout === true;
        settings.fitBackground = input.fitBackground === true;
        settings.buttonTransparent = input.buttonTransparent === true;
        settings.reelBorder = (input.reelBorder ?? data.config.settings.reelBorder ?? defaults.reelBorder) === true;
        settings.winnerTransparent = input.winnerTransparent ?? data.config.settings.winnerTransparent ?? false;
        settings.winnerTransparent = settings.winnerTransparent === true;
        settings.winnerTextColor = input.winnerTextColor ?? data.config.settings.winnerTextColor ?? defaults.winnerTextColor;
        if (!/^#[a-f0-9]{6}$/i.test(settings.winnerTextColor)) throw new Error('Màu chữ popup không hợp lệ.');
        settings.reelTextColor = input.reelTextColor ?? data.config.settings.reelTextColor ?? defaults.reelTextColor;
        if (!/^#[a-f0-9]{6}$/i.test(settings.reelTextColor)) throw new Error('Màu chữ ô quay số không hợp lệ.');
        for (const [key, min, max] of [['winnerWidth', 280, 3840], ['winnerHeight', 200, 2160], ['winnerContentY', 0, 100]]) {
          const value = Number(input[key] ?? data.config.settings[key] ?? defaults[key]);
          settings[key] = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : defaults[key];
        }
        for (const [key, min, max] of [['reelY', 0, 100], ['reelWidth', 20, 100], ['reelHeight', 120, 1000], ['reelRadius', 0, 200], ['reelFont', 26, 100], ['buttonY', 0, 100], ['buttonWidth', 80, 1600], ['buttonHeight', 30, 300], ['buttonRadius', 0, 150]]) {
          const value = Number(input[key] ?? defaults[key]);
          settings[key] = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : defaults[key];
        }
        settings.buttonText = String(input.buttonText ?? defaults.buttonText).trim().slice(0, 100);
        if (settings.background) await background(settings.background);
        if (settings.waitingBackground) await background(settings.waitingBackground);
        if (settings.buttonBackground) await background(settings.buttonBackground);
        if (settings.reelBackground) await background(settings.reelBackground);
        if (settings.winnerBackground) await background(settings.winnerBackground);
        const config = {...data.config, settings};
        await write(`src/setting/${id}.json`, JSON.stringify(config)); data.config = config;
        return summary(data);
      }
      const q = (url.searchParams.get('q') || '').toLowerCase(), status = url.searchParams.get('status') || 'all';
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1), items = []; let total = 0;
      for (const [i, person] of data.people.entries()) {
        const win = data.byPerson.get(person.id);
        if (status === 'won' && !win || status === 'absent' && !win?.absent || status === 'eligible' && win) continue;
        if (q && !((person.employeeCode || '') + ' ' + person.email + ' ' + person.name + ' ' + person.department).toLowerCase().includes(q)) continue;
        if (total >= (page - 1) * 50 && items.length < 50) items.push({...person, win});
        total++;
        if (i % 4000 === 0) {await new Promise(resolve => setTimeout(resolve, 0)); if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');}
      }
      return {items, total, page, pageSize: 50};
    };
    return input ? exclusive(execute) : execute();
  }
  async function exportBatch(id, onlyWins) {
    const data = await load(id);
    function* rows() {
      yield ['Mã nhân viên', 'Tên nhân viên', 'Email công ty', 'Phòng ban', 'Trạng thái', 'Giải thưởng', 'Thời gian'];
      for (const person of data.people) {
        const win = data.byPerson.get(person.id);
        if (onlyWins && !win) continue;
        yield [person.employeeCode || '', person.name, person.email, person.department, win ? win.absent ? 'Vắng mặt' : 'Trúng giải' : 'Chưa trúng', win?.prize || '', win?.at || ''];
      }
    }
    const blob = await GalaExcel.write(rows());
    await write(`${data.config.directory}/ket-qua-${onlyWins ? 'trung-thuong' : 'toan-bo'}.xlsx`, blob);
    return blob;
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  return {attach, route, background, exportBatch, download, defaults, randomIndex, get batchErrors() {return batchErrors;}, get root() {return root;}, get generation() {return generation;}};
})();