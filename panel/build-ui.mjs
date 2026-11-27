import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const result = await esbuild.build({
  entryPoints: [path.join(__dirname, 'src/app.js')],
  bundle: true,
  minify: true,
  format: 'esm',
  write: false,
  target: 'es2022',
});

const js = result.outputFiles[0].text;
const template = fs.readFileSync(path.join(__dirname, 'src/template.html'), 'utf8');
const html = template.replace('<!-- INLINE_SCRIPT -->', () => `<script type="module">\n${js}\n</script>`);

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist/app.html'), html, 'utf8');
console.log(`Built dist/app.html (${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)} KB)`);
