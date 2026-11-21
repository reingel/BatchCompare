const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const vm = require('node:vm');
function load(source) {
  const { outputFiles } = buildSync({ entryPoints: [source], bundle: true, write: false, platform: 'node', format: 'cjs' });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, { module, exports: module.exports, Buffer, TextDecoder, require });
  return module.exports;
}
const { decodeText } = load('src/encoding.ts');
const { isBinary } = load('src/compare.ts');
const text = '한글 주석 // 비교\n';

test('decodeText detects UTF-8, BOMs and CP949 Korean text', () => {
  assert.equal(decodeText(Buffer.from(text, 'utf8')), text);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])), text);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])), text);
  // '한글 주석 // 비교\n' in CP949
  const cp949 = Buffer.from('c7d1b1db20c1d6bcae202f2f20baf1b1b30a', 'hex');
  assert.equal(decodeText(cp949), text);
});

test('UTF-16 text with a BOM is not treated as binary', () => {
  assert.equal(isBinary(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])), false);
  assert.equal(isBinary(Buffer.from([0x50, 0x4b, 0x03, 0x00])), true);
});

test('detectAndDecode reports the detected encoding', () => {
  const { detectAndDecode } = load('src/encoding.ts');
  assert.equal(detectAndDecode(Buffer.from(text, 'utf8')).encoding, 'UTF-8');
  assert.equal(detectAndDecode(Buffer.from('c7d1b1db0a', 'hex')).encoding, 'CP949 (EUC-KR)');
  assert.equal(detectAndDecode(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('ab', 'utf16le').swap16()])).encoding, 'UTF-16 BE');
});
