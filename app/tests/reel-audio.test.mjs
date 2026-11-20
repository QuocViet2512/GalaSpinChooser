import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const effect = source.slice(source.indexOf('let reelAudio;'), source.indexOf('async function highlightWinner()'));

function fixture(Audio) {
  let frame;
  const positions = [];
  const context = vm.createContext({window: {AudioContext: Audio}, document: {hidden: false},
    state: {sample: []}, makeCard: value => value, $: () => ({replaceChildren() {}}),
    paintTrack: position => positions.push(position), matchMedia: () => ({matches: false}),
    requestAnimationFrame: callback => {frame = callback;}});
  vm.runInContext(effect, context);
  return {context, positions, run: code => vm.runInContext(code, context),
    frame(time) {const callback = frame; frame = undefined; callback(time);}};
}

test('metallic tings have a short decaying tail, are bounded and disconnected, and tolerate unavailable audio', () => {
  const starts = [], stops = [], ended = [];
  let disconnected = 0, buffers = 0, samples;
  const param = {setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}};
  const audio = {state: 'suspended', currentTime: 0, sampleRate: 48000, destination: {},
    resume() {this.state = 'running'; return Promise.resolve();},
    createBuffer(channels, length, rate) {
      buffers++; assert.equal(channels, 1); assert.equal(rate, 48000);
      samples = new Float32Array(length);
      return {getChannelData: () => samples};
    },
    createBufferSource() {const click = {connect() {}, disconnect() {disconnected++;},
      start(time) {starts.push(time);}, stop(time) {stops.push(time); ended.push(() => click.onended());}}; return click;},
    createGain: () => ({gain: param, connect() {}, disconnect() {disconnected++;}})};
  const f = fixture(function () {return audio;});
  f.run('prepareReelAudio(); playReelTick(); playReelTick();');
  assert.equal(starts.length, 1);
  assert.equal(stops[0], .18);
  assert.equal(samples.length, 8640);
  assert.equal(samples[0], 0);
  assert.ok(samples.every(value => Number.isFinite(value) && Math.abs(value) <= 1));
  const energy = values => values.reduce((sum, value) => sum + value * value, 0);
  assert.ok(energy(samples.slice(0, 240)) > energy(samples.slice(-240)) * 10);
  audio.currentTime = .03;
  f.run('playReelTick()');
  assert.equal(starts.length, 2);
  assert.equal(buffers, 1);
  f.context.document.hidden = true;
  audio.currentTime = .1;
  f.run('playReelTick()');
  assert.equal(starts.length, 2);
  ended.forEach(callback => callback());
  assert.equal(disconnected, 4);
  assert.doesNotThrow(() => fixture(undefined).run('prepareReelAudio(); playReelTick();'));
  assert.doesNotThrow(() => fixture(function () {throw Error('blocked');}).run('prepareReelAudio(); playReelTick();'));
});

test('ticks follow card changes, slow with the reel, and do not continue after stopping', async () => {
  const f = fixture(undefined);
  f.run('var ticks = 0; playReelTick = () => {ticks++;};');
  const done = f.run('animateSpin({person: {}}, 4)');
  f.frame(0);
  assert.equal(f.run('ticks'), 0);
  f.frame(100);
  assert.equal(f.run('ticks'), 1);
  f.frame(100);
  assert.equal(f.run('ticks'), 1);
  for (let time = 200; time <= 4000; time += 100) f.frame(time);
  await done;
  assert.equal(f.positions.at(-1), 5);
  assert.ok(f.run('ticks') > 10);
  assert.deepEqual(f.positions.slice(-2).map(Math.round), [5, 5]);
});