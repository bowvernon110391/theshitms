import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locates Blender and runs the bake script headlessly.
 *
 *   npm run bake:blender -- --samples=128 --atlas=2048 --margin=8
 *
 * A single `--` is enough. npm strips that one, so the script receives the
 * options directly; they are forwarded to Python, and Blender's own required
 * `--` separator is added when the command is built.
 *
 * Requiring a second `--` was a trap: `npm run ... -- --samples=128` would
 * parse but forward *nothing*, silently baking at the default settings and
 * wasting a nine-minute run. Options are therefore accepted with or without an
 * explicit separator.
 *
 * Blender has no reliable launcher across platforms, so this probes the usual
 * install locations rather than assuming it is on PATH. Failing with a clear
 * message is better than a spawn error, because the fix is "install Blender",
 * not "fix the code".
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ── Argument passthrough ─────────────────────────────────────── */

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');

// After an explicit separator, take everything following it. Without one, take
// only the option-shaped arguments, so a stray positional argument cannot be
// mistaken for a bake setting.
const forwarded =
  separator >= 0
    ? argv.slice(separator + 1)
    : argv.filter((arg) => arg.startsWith('--'));

if (separator < 0 && argv.some((a) => !a.startsWith('--'))) {
  console.warn(
    `  ! ignoring argument(s) that are not options: ` +
      argv.filter((a) => !a.startsWith('--')).join(' ')
  );
}

if (forwarded.length > 0) {
  console.log(`▲ bake options: ${forwarded.join(' ')}`);
} else {
  console.log('▲ bake options: none (using blender-bake.py defaults)');
}

/* ── Locate Blender ───────────────────────────────────────────── */

const CANDIDATES = [];

if (process.env.BLENDER) CANDIDATES.push(process.env.BLENDER);

if (process.platform === 'win32') {
  for (const base of [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['LOCALAPPDATA'],
  ]) {
    if (!base) continue;
    const dir = path.join(base, 'Blender Foundation');
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      // Windows installs to ".../Blender Foundation/Blender 5.2/blender.exe".
      CANDIDATES.push(path.join(dir, entry, 'blender.exe'));
    }
  }
} else if (process.platform === 'darwin') {
  CANDIDATES.push('/Applications/Blender.app/Contents/MacOS/Blender');
} else {
  CANDIDATES.push('/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender');
}

// Whatever the shell would find, as a last resort.
CANDIDATES.push('blender');

let blender = null;
for (const candidate of CANDIDATES) {
  if (candidate === 'blender') {
    const probe = spawnSync('blender', ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) {
      blender = 'blender';
      break;
    }
    continue;
  }
  if (fs.existsSync(candidate)) {
    blender = candidate;
    break;
  }
}

if (!blender) {
  console.error('✗ could not find Blender');
  console.error('  install it from https://www.blender.org/download/, or set BLENDER=/path/to/blender');
  process.exit(1);
}

/* ── Run ──────────────────────────────────────────────────────── */

const script = path.join(HERE, 'blender-bake.py');

const args = [
  '--background',
  '--factory-startup',
  '--python',
  script,
  '--',
  ...forwarded,
];

console.log(`▲ running Blender: ${blender}`);

const result = spawnSync(blender, args, {
  stdio: 'inherit',
  cwd: ROOT,
});

if (result.error) {
  console.error(`✗ failed to run Blender: ${result.error.message}`);
  process.exit(1);
}

// Blender reports script errors through its own status, so this is the signal
// that the bake actually completed rather than merely started.
if (result.status !== 0) {
  console.error(`✗ Blender exited with status ${result.status}`);
  process.exit(result.status ?? 1);
}
