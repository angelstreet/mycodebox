// Build build/icon.icns from the dashboard's public/icon-512.png. Needs macOS (sips + iconutil).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, '..', 'public', 'icon-512.png');
const build = path.join(root, 'build');
const set = path.join(build, 'icon.iconset');
mkdirSync(build, { recursive: true });
copyFileSync(src, path.join(build, 'icon.png'));
rmSync(set, { recursive: true, force: true });
mkdirSync(set);
// iconutil's valid names -> pixel size (1024px for 512@2x is not available from the 512px source, so it is left out)
const sizes = { 'icon_16x16.png': 16, 'icon_16x16@2x.png': 32, 'icon_32x32.png': 32, 'icon_32x32@2x.png': 64,
  'icon_128x128.png': 128, 'icon_128x128@2x.png': 256, 'icon_256x256.png': 256, 'icon_256x256@2x.png': 512, 'icon_512x512.png': 512 };
for (const [name, px] of Object.entries(sizes)) {
  execFileSync('sips', ['-z', String(px), String(px), src, '--out', path.join(set, name)], { stdio: 'ignore' });
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(build, 'icon.icns')]);
rmSync(set, { recursive: true, force: true });
console.log('wrote build/icon.icns');
