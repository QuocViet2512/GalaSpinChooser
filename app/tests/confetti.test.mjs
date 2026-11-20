import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const effect = source.slice(source.indexOf('function stopConfetti()'), source.indexOf('function badge('));

function fixture(width, reduced = false) {
  let callback, draws = 0;
  const colors = new Set();
  const ctx = {scale() {}, clearRect() {}, save() {}, restore() {}, translate() {}, rotate() {},
    fillRect() {draws++; colors.add(this.fillStyle);}};
  const canvas = {style: {}, getContext: () => ctx};
  const context = vm.createContext({$: () => canvas, innerWidth: width, innerHeight: 900, devicePixelRatio: 3,
    matchMedia: () => ({matches: reduced}), requestAnimationFrame: fn => {callback = fn; return 1;},
    cancelAnimationFrame: () => {callback = undefined;}});
  vm.runInContext(`let confettiFrame; ${effect}; confetti();`, context);
  return {canvas, colors, get draws() {return draws;}, get scheduled() {return !!callback;},
    frame(time) {const fn = callback; callback = undefined; fn(time);},
    stop() {vm.runInContext('stopConfetti()', context);}};
}

for (const [width, perBurst] of [[1440, 240], [390, 140]]) {
  test(`three vivid bursts with bounded particle count at width ${width}`, () => {
    const f = fixture(width);
    assert.equal(f.canvas.width, width * 2);
    f.frame(0); assert.equal(f.draws, perBurst);
    f.frame(650); assert.equal(f.draws, perBurst * 3);
    f.frame(1300); assert.equal(f.draws, perBurst * 6);
    assert.equal(f.colors.size, 8);
    f.frame(7400);
    assert.equal(f.canvas.style.display, 'none');
    assert.equal(f.scheduled, false);
  });
}
test('closing stops the animation and reduced motion skips all particles', () => {
  const active = fixture(1440); active.stop();
  assert.equal(active.scheduled, false);
  assert.equal(active.canvas.style.display, 'none');
  const reduced = fixture(1440, true);
  assert.equal(reduced.scheduled, false);
  assert.equal(reduced.draws, 0);
  assert.equal(reduced.canvas.style.display, 'none');
});