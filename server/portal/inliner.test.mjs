// Unit tests for the portal's pure render helpers. `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

process.env.NODE_ENV = 'test';
const { inlineApp, treeHashOf, inflateArchive } = await import('./index.mjs');

test('inlineApp inlines local css/js, keeps external, strips meta-refresh', () => {
  const files = {
    'index.html': Buffer.from('<head><link rel="stylesheet" href="s.css"><meta http-equiv="refresh" content="0;url=http://evil"><script src="a.js"></script><script src="https://cdn/x.js"></script></head>'),
    's.css': Buffer.from('body{color:red}'),
    'a.js': Buffer.from('console.log(1)'),
  };
  const h = inlineApp(files);
  assert.ok(h.includes('<style>') && h.includes('body{color:red}'), 'css inlined');
  assert.ok(h.includes('console.log(1)') && !/src=["']a\.js/.test(h), 'js inlined');
  assert.ok(h.includes('https://cdn/x.js'), 'external script kept');
  assert.ok(!/http-equiv\s*=\s*["']?\s*refresh/i.test(h), 'meta-refresh stripped');
  assert.ok(h.includes('Content-Security-Policy'), 'CSP injected');
});

test('treeHashOf is deterministic and order-independent', () => {
  const a = { 'index.html': Buffer.from('x'), 'b.css': Buffer.from('y') };
  const b = { 'b.css': Buffer.from('y'), 'index.html': Buffer.from('x') };
  assert.equal(treeHashOf(a), treeHashOf(b));
  assert.notEqual(treeHashOf(a), treeHashOf({ 'index.html': Buffer.from('z'), 'b.css': Buffer.from('y') }));
});

test('inflateArchive round-trips the length-prefixed gzip format', () => {
  const path = Buffer.from('index.html'); const data = Buffer.from('<p>hi</p>');
  const head = Buffer.alloc(8); head.writeUInt32BE(path.length, 0); head.writeUInt32BE(data.length, 4);
  const gz = gzipSync(Buffer.concat([head, path, data]));
  const files = inflateArchive(new Uint8Array(gz));
  assert.equal(files['index.html'].toString('utf8'), '<p>hi</p>');
});
