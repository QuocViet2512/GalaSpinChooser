import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import test from 'node:test';

class MemoryDirectory {
  constructor(name = 'test') {this.name = name; this.kind = 'directory'; this.children = new Map(); this.fail = false;}
  async getDirectoryHandle(name, {create = false} = {}) {
    if (!this.children.has(name)) {
      if (!create) throw new DOMException('Missing directory', 'NotFoundError');
      this.children.set(name, new MemoryDirectory(name));
    }
    return this.children.get(name);
  }
  async getFileHandle(name, {create = false} = {}) {
    if (!this.children.has(name)) {
      if (!create) throw new DOMException('Missing file', 'NotFoundError');
      const parent = this;
      const handle = {kind: 'file', name, bytes: new Uint8Array(), async getFile() {return new Blob([this.bytes]);}, async createWritable({keepExistingData = false} = {}) {
        if (parent.fail) throw new Error('Permission denied');
        let bytes = keepExistingData ? handle.bytes.slice() : new Uint8Array(), position = 0;
        return {async seek(n) {position = n;}, async write(value) {
          const incoming = new Uint8Array(await new Blob([value]).arrayBuffer());
          const output = new Uint8Array(Math.max(bytes.length, position + incoming.length));
          output.set(bytes); output.set(incoming, position); bytes = output; position += incoming.length;
        }, async close() {if (parent.fail) throw new Error('Disk full'); handle.bytes = bytes;}, async abort() {}};
      }};
      this.children.set(name, handle);
    }
    return this.children.get(name);
  }
  async removeEntry(name) {this.children.delete(name);}
  async *entries() {yield* this.children.entries();}
}
const source = await readFile(new URL('../src/storage.js', import.meta.url), 'utf8');
function storage() {
  const context = vm.createContext({window: {}, crypto: webcrypto, Uint8Array, Uint32Array, Map, Date, URL, Blob, DOMException, TextDecoder, setTimeout,
    GalaExcel: {people: async input => ({people: input.people, report: {accepted: input.people.length, duplicates: 0, invalid: 0}})}});
  vm.runInContext(source, context); return context.window.GalaStorage;
}
async function fixture(count = 100) {
  const root = new MemoryDirectory(), store = storage(); await store.attach(root);
  const imported = new Blob(['original']); imported.name = 'staff.csv';
  imported.people = Array.from({length: count}, (_, id) => ({id, employeeCode: `NV${String(id).padStart(6, '0')}`, email: `staff${id}@example.com`, name: `Staff ${id}`, department: 'IT'}));
  const batch = await store.route('/api/batches', {name: 'Test', file: imported});
  return {root, store, batch, base: `/api/batches/${batch.id}`};
}
test('30k people: bounded page/sample, 100 unique draws, retry and restart', async () => {
  const {root, store, batch, base} = await fixture(30000);
  assert.match(batch.directory, /^src\/data\/\d{4}_\d{2}_\d{2}_[a-z0-9]{8}$/);
  const created = new Date(batch.createdAt), pad = n => String(n).padStart(2, '0');
  assert.equal(batch.directory, `src/data/${created.getFullYear()}_${pad(created.getMonth() + 1)}_${pad(created.getDate())}_${batch.id.split('_')[1]}`);
  assert.equal((await store.route(base + '/people')).items.length, 50);
  assert.equal((await store.route(base + '/stage')).sample.length, 80);
  const seen = new Set();
  for (let i = 0; i < 100; i++) seen.add((await store.route(base + '/draw', {requestId: `request_${i}`, prize: 'Gold'})).person.email);
  assert.equal(seen.size, 100);
  const win = await store.route(base + '/draw', {requestId: 'request_0'});
  assert.equal(win.remaining, 29900);
  await store.route(base + '/absent', {winId: win.id});
  const recovered = storage(); await recovered.attach(root);
  const retry = await recovered.route(base + '/draw', {requestId: 'request_0'});
  assert.equal(retry.id, win.id); assert.equal(retry.absent, true);
  assert.equal((await recovered.route('/api/batches'))[0].won, 100);
  assert.equal((await recovered.route(base + '/people?q=staff29999')).total, 1);
  const byCode = await recovered.route(base + '/people?q=NV029999');
  assert.equal(byCode.total, 1);
  assert.equal(byCode.items[0].employeeCode, 'NV029999');
  assert.equal(batch.total, 30000);
});
test('failed log write does not remove participant or return a winner', async () => {
  const {root, store, batch, base} = await fixture(1);
  let dir = root;
  for (const part of batch.directory.split('/')) dir = await dir.getDirectoryHandle(part);
  dir.fail = true;
  await assert.rejects(store.route(base + '/draw', {requestId: 'request_fail'}));
  dir.fail = false;
  assert.equal((await store.route(base + '/stage')).batch.remaining, 1);
  const win = await store.route(base + '/draw', {requestId: 'request_fail'});
  assert.equal(win.remaining, 0);
  await assert.rejects(store.route(base + '/draw', {requestId: 'request_more'}), /hết/);
  assert.equal((await store.route(base + '/draw', {requestId: 'request_fail'})).id, win.id);
});
test('corrupt log stops recovery; no silent reset', async () => {
  const {root, store, batch, base} = await fixture(1);
  await store.route(base + '/draw', {requestId: 'request_good'});
  let dir = root;
  for (const part of batch.directory.split('/')) dir = await dir.getDirectoryHandle(part);
  const log = await dir.getFileHandle('events.jsonl'); log.bytes = new TextEncoder().encode('not json\n');
  const recovered = storage(); await recovered.attach(root);
  assert.equal((await recovered.route('/api/batches')).length, 0);
  assert.match(recovered.batchErrors[0].message, /Log bị lỗi/);
  await assert.rejects(recovered.route(base + '/draw', {requestId: 'request_good'}), /Log bị lỗi/);
});
test('missing old batch does not block healthy batches after reload or rewrite configs', async () => {
  const {root, batch} = await fixture(2);
  const settings = await (await root.getDirectoryHandle('src')).getDirectoryHandle('setting');
  const bad = await settings.getFileHandle('20200101_deadbeef.json', {create: true});
  bad.bytes = new TextEncoder().encode(JSON.stringify({directory: 'src/data/missing-old-batch'}));
  const before = [...settings.children.keys()].sort();
  const recovered = storage(); await recovered.attach(root);
  const batches = await recovered.route('/api/batches');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].id, batch.id);
  assert.equal(recovered.batchErrors[0].id, '20200101_deadbeef');
  assert.match(recovered.batchErrors[0].message, /src\/data\/missing-old-batch\/people.json/);
  assert.deepEqual([...settings.children.keys()].sort(), before);
});
test('legacy nested directory remains readable and writable without migration', async () => {
  const {root, store, batch, base} = await fixture(2);
  const first = await store.route(base + '/draw', {requestId: 'legacy_first'});
  const data = await (await root.getDirectoryHandle('src')).getDirectoryHandle('data');
  const leaf = data.children.get(batch.directory.split('/').pop());
  const year = batch.directory.split('/').pop().slice(0, 4);
  const legacyPath = `src/data/19/11/${year}_${batch.id.split('_')[1]}`;
  const month = await (await data.getDirectoryHandle('19', {create: true})).getDirectoryHandle('11', {create: true});
  month.children.set(legacyPath.split('/').pop(), leaf);
  data.children.delete(batch.directory.split('/').pop());
  const settings = await (await root.getDirectoryHandle('src')).getDirectoryHandle('setting');
  const configFile = await settings.getFileHandle(`${batch.id}.json`);
  const config = JSON.parse(await (await configFile.getFile()).text());
  config.directory = legacyPath;
  configFile.bytes = new TextEncoder().encode(JSON.stringify(config));
  const recovered = storage(); await recovered.attach(root);
  assert.equal((await recovered.route('/api/batches'))[0].directory, legacyPath);
  assert.equal((await recovered.route(base + '/draw', {requestId: 'legacy_first'})).id, first.id);
  await recovered.route(base + '/absent', {winId: first.id});
  assert.equal((await recovered.route(base + '/draw', {requestId: 'legacy_second'})).remaining, 0);
  assert.equal(data.children.size, 1); // No replacement directory created.
});
test('blank stage settings persist across reload without restoring defaults', async () => {
  const {root, store, base} = await fixture(1);
  await store.route(base + '/settings', {title: '   ', subtitle: '', prize: '', buttonText: '   ', accent: '#FF7422', backgroundColor: '#101114', duration: 3});
  const recovered = storage(); await recovered.attach(root);
  const {settings} = (await recovered.route(base + '/stage')).batch;
  for (const key of ['title', 'subtitle', 'prize', 'buttonText']) assert.equal(settings[key], '');
  assert.equal((await recovered.route(base + '/draw', {requestId: 'blank_settings_draw'})).prize, '');
});
test('manual layout persists, bounds invalid coordinates, and supplies legacy defaults', async () => {
  const {root, store, base} = await fixture(1);
  const original = (await store.route(base + '/stage')).batch.settings;
  assert.equal(original.manualLayout, false);
  assert.equal(original.fitBackground, false);
  assert.equal(original.buttonTransparent, false);
  assert.equal(original.reelFont, 42);
  await store.route(base + '/settings', {...original, manualLayout: true, reelY: 55, reelWidth: 88, reelHeight: 400, reelRadius: 32, reelFont: 54, buttonY: 89, buttonWidth: 420, buttonHeight: 72, buttonRadius: 24, buttonText: 'QUAY NGAY', buttonTransparent: true});
  const recovered = storage(); await recovered.attach(root);
  const saved = (await recovered.route(base + '/stage')).batch.settings;
  assert.equal(saved.manualLayout, true);
  for (const [key, value] of Object.entries({reelY: 55, reelWidth: 88, reelHeight: 400, reelRadius: 32, reelFont: 54, buttonY: 89, buttonWidth: 420, buttonHeight: 72, buttonRadius: 24, buttonText: 'QUAY NGAY', buttonTransparent: true})) assert.equal(saved[key], value);
  const bounded = await recovered.route(base + '/settings', {...saved, reelRadius: -1, reelY: 120, reelWidth: 999, reelFont: 'invalid'});
  assert.equal(bounded.settings.reelRadius, 0);
  assert.equal(bounded.settings.reelY, 100);
  assert.equal(bounded.settings.reelWidth, 100);
  assert.equal(bounded.settings.reelFont, 42);
  await recovered.route(base + '/settings', {...saved, fitBackground: true});
  const fitted = storage(); await fitted.attach(root);
  assert.equal((await fitted.route(base + '/stage')).batch.settings.fitBackground, true);
});
test('winner popup size, content coordinates and transparency persist per batch with bounds', async () => {
  const {root, store, base} = await fixture(1);
  const original = (await store.route(base + '/stage')).batch.settings;
  assert.equal(original.winnerWidth, 780); assert.equal(original.winnerHeight, 400);
  assert.equal(original.winnerContentY, 50);
  assert.equal(original.winnerTransparent, false);
  assert.equal(original.winnerTextColor, '#ffffff');
  assert.equal(original.reelBorder, true);
  const custom = {winnerWidth: 1000, winnerHeight: 600, winnerContentY: 70, winnerTransparent: true, winnerTextColor: '#12ab34', reelTextColor: '#ab1234', reelBorder: false};
  await store.route(base + '/settings', {...original, ...custom});
  const recovered = storage(); await recovered.attach(root);
  const saved = (await recovered.route(base + '/stage')).batch.settings;
  for (const [key, value] of Object.entries(custom)) assert.equal(saved[key], value);
  await assert.rejects(recovered.route(base + '/settings', {...saved, winnerTextColor: 'not-a-color'}), /Màu chữ popup/);
  await assert.rejects(recovered.route(base + '/settings', {...saved, reelTextColor: 'invalid'}), /Màu chữ ô quay số/);
  const other = await recovered.route('/api/batches', {name: 'Other popup'});
  assert.equal(other.settings.winnerTextColor, '#ffffff');
  assert.equal(other.settings.winnerWidth, 780); assert.equal(other.settings.winnerTransparent, false);
  const bounded = await recovered.route(base + '/settings', {...saved, winnerWidth: 9999, winnerHeight: -1, winnerContentY: 200});
  assert.equal(bounded.settings.winnerWidth, 3840); assert.equal(bounded.settings.winnerHeight, 200);
  assert.equal(bounded.settings.winnerContentY, 100);
  const invalid = await recovered.route(base + '/settings', {...saved, winnerWidth: 'invalid', winnerTransparent: 'true'});
  assert.equal(invalid.settings.winnerWidth, 780); assert.equal(invalid.settings.winnerTransparent, false);
});
for (const field of ['buttonBackground', 'reelBackground', 'winnerBackground']) test(`${field} artwork is offline, per batch, validated, persisted, replaced and removable`, async () => {
  const {root, store, base} = await fixture(1);
  const original = (await store.route(base + '/stage')).batch.settings;
  assert.equal(original[field], '');
  const image = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], {type: 'image/png'});
  const first = (await store.route('/api/background', {file: image})).url;
  await store.route(base + '/settings', {...original, [field]: first});
  const other = await store.route('/api/batches', {name: 'Other'});
  assert.equal(other.settings[field], '');
  const recovered = storage(); await recovered.attach(root);
  assert.equal((await recovered.route(base + '/stage')).batch.settings[field], first);
  assert.match(await recovered.background(first), /^blob:/);
  await assert.rejects(recovered.route(base + '/settings', {...original, [field]: 'https://example.com/artwork.png'}), /Ảnh nền không hợp lệ/);
  await assert.rejects(recovered.route('/api/background', {file: new Blob(['not an image'])}), /Chỉ nhận/);
  await assert.rejects(recovered.route('/api/background', {file: {size: 10_000_001}}), /10 MB/);
  assert.equal((await recovered.route(base + '/stage')).batch.settings[field], first);
  const second = (await recovered.route('/api/background', {file: image})).url;
  assert.notEqual(second, first);
  await recovered.route(base + '/settings', {...original, [field]: second});
  assert.equal((await recovered.route(base + '/stage')).batch.settings[field], second);
  await recovered.route(base + '/settings', {...original, [field]: ''});
  const removed = storage(); await removed.attach(root);
  assert.equal((await removed.route(base + '/stage')).batch.settings[field], '');
});
test('create an empty batch, import later, and replace data with a confirmed fresh start', async () => {
  const root = new MemoryDirectory(), store = storage(); await store.attach(root);
  const empty = await store.route('/api/batches', {name: 'Empty gala'});
  const base = `/api/batches/${empty.id}`;
  assert.equal(empty.total, 0); assert.equal(empty.won, 0);
  assert.equal((await store.route(base + '/stage')).sample.length, 0);
  await assert.rejects(store.route(base + '/draw', {requestId: 'empty_request'}), /hết người/);
  const imported = new Blob(['csv']); imported.name = 'staff.csv';
  imported.people = [{id: 0, email: 'first@example.com', name: 'First', employeeCode: '001'}];
  await store.route(base + '/settings', {...empty.settings, title: 'Saved title', reelY: 42});
  await store.route(base + '/import', {file: imported});
  await store.route(base + '/draw', {requestId: 'first_request'});
  await assert.rejects(store.route(base + '/import', {file: imported}), /xác nhận/);
  assert.equal((await store.route(base + '/winners')).length, 1);
  imported.people = [{id: 0, email: 'new@example.com', name: 'New', employeeCode: '002'}];
  const replaced = await store.route(base + '/import', {file: imported, confirmReset: true});
  assert.equal(replaced.id, empty.id); assert.equal(replaced.name, 'Empty gala');
  assert.equal(replaced.total, 1); assert.equal(replaced.won, 0); assert.equal(replaced.remaining, 1);
  assert.equal(replaced.settings.title, 'Saved title'); assert.equal(replaced.settings.reelY, 42);
  const recovered = storage(); await recovered.attach(root);
  assert.equal((await recovered.route(base + '/winners')).length, 0);
  assert.equal((await recovered.route(base + '/people')).items[0].email, 'new@example.com');
  assert.equal((await recovered.route(base + '/draw', {requestId: 'first_request'})).person.email, 'new@example.com');
});

test('failed replacement commit preserves the previous roster and winners', async () => {
  const {root, store, batch, base} = await fixture(2);
  const win = await store.route(base + '/draw', {requestId: 'original_request'});
  const settings = await (await root.getDirectoryHandle('src')).getDirectoryHandle('setting');
  settings.fail = true;
  const imported = new Blob(['csv']); imported.name = 'staff.csv';
  imported.people = [{id: 0, email: 'replacement@example.com'}];
  await assert.rejects(store.route(base + '/import', {file: imported, confirmReset: true}), /Permission denied/);
  assert.equal((await store.route(base + '/stage')).batch.directory, batch.directory);
  assert.equal((await store.route(base + '/winners'))[0].id, win.id);
  settings.fail = false;
  const recovered = storage(); await recovered.attach(root);
  assert.equal((await recovered.route(base + '/people')).total, 2);
  assert.equal((await recovered.route(base + '/winners'))[0].id, win.id);
});
