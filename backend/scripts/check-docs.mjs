// Read-only documentation contracts: links, examples, commands and captured images.
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../', import.meta.url));
process.chdir(root);
const files = ['README.md', ...readdirSync('docs').filter(name => name.endsWith('.md')).map(name => `docs/${name}`)];
const readme = readFileSync('README.md', 'utf8').replace(/^\uFEFF/, '');
const contents = new Map(files.map(file => [resolve(root, file), readFileSync(file, 'utf8')]));
const withoutFences = text => text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
const anchors = text => {
  const seen = new Map();
  return new Set([...withoutFences(text).matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => {
    const slug = match[1].trim().toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    return count ? `${slug}-${count}` : slug;
  }));
};
let links = 0, diagrams = 0, scriptReferences = 0;
const scripts = new Set(['ci', 'start', 'test']);
for (const directory of ['backend', 'frontend']) {
  const pkg = JSON.parse(readFileSync(`${directory}/package.json`, 'utf8'));
  Object.keys(pkg.scripts).forEach(name => scripts.add(name));
  assert.ok(existsSync(`${directory}/package-lock.json`), `${directory}: lockfile required for npm ci`);
  assert.equal(pkg.engines.node, '>=22.22.0');
}
for (const [file, text] of contents) {
  assert.equal((text.match(/^```/gm) ?? []).length % 2, 0, `${file}: unbalanced fences`);
  diagrams += (text.match(/^```mermaid$/gm) ?? []).length;
  for (const match of withoutFences(text).matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^https?:\/\//.test(target)) continue;
    const [relative, fragment] = target.split('#');
    const path = relative ? resolve(dirname(file), decodeURIComponent(relative)) : file;
    assert.ok(existsSync(path), `${file}: missing ${target}`);
    if (fragment) {
      const targetText = contents.get(path) ?? readFileSync(path, 'utf8');
      assert.ok(anchors(targetText).has(decodeURIComponent(fragment)), `${file}: missing anchor ${target}`);
    }
    if (extname(path) === '.png') {
      assert.equal(readFileSync(path).subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${path}: not a PNG`);
    }
    links++;
  }
  for (const match of text.matchAll(/npm (?:run ([a-z][a-z0-9:_-]*)|(ci|start|test))\b/g)) {
    assert.ok(scripts.has(match[1] ?? match[2]), `${file}: undocumented npm script ${match[0]}`);
    scriptReferences++;
  }
}
let variables = 0, credentials = 0;
for (const file of ['backend/.env.example', 'frontend/.env.example']) {
  for (const match of readFileSync(file, 'utf8').matchAll(/^([A-Z_]+)=(.*)$/gm)) {
    assert.ok(readme.includes(match[1]), `README missing environment variable ${match[1]}`);
    variables++;
    if (match[1].startsWith('SEED_')) {
      assert.ok(readme.includes(match[2].trim()), `Demo credential changed: ${match[1]}`);
      credentials++;
    }
  }
}
const manifest = JSON.parse(readFileSync('docs/assets/screenshots/capture-info.json', 'utf8'));
assert.equal(manifest.origin, 'demo');
assert.equal(manifest.mode, 'read-only');
assert.equal(manifest.captures.length, 11);
assert.equal(new Set(manifest.captures.map(capture => capture.file)).size, 11);
for (const capture of manifest.captures) {
  assert.equal(capture.file, capture.file.split('/').pop());
  const png = readFileSync(`docs/assets/screenshots/${capture.file}`);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const dimensions = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  assert.equal(dimensions.width, capture.viewport.width);
  if (capture.fullPage) {
    assert.ok(dimensions.height >= capture.viewport.height);
    assert.deepEqual(dimensions, capture.imageDimensions);
    const manager = capture.file.startsWith('gestor-');
    assert.equal(capture.path.split('?')[0], manager ? '/manager' : '/dashboard');
    assert.equal(capture.user.role, manager ? 'gestor' : capture.file.includes('solicitante') ? 'solicitante' : 'ti');
    assert.ok(capture.title.startsWith(manager ? 'Visão gerencial' : 'Dashboard'));
  } else assert.equal(dimensions.height, capture.viewport.height);
  assert.deepEqual(capture.viewport, capture.file.endsWith('-mobile.png') ? { width: 390, height: 844 } : { width: 1440, height: 900 });
}
assert.equal(diagrams, 4);
console.log(JSON.stringify({ screenshots: manifest.captures.length, markdownFiles: files.length, relativeLinksAndAnchors: links, mermaidDiagrams: diagrams,
  npmScriptReferences: scriptReferences, exampleVariables: variables, demoCredentialValues: credentials }, null, 2));
console.log('PASS: paths, anchors, PNGs, fences, scripts, engines, variables and demo credentials. Mermaid syntax reviewed manually.');
