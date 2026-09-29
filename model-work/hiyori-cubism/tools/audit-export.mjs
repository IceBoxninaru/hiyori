// CLI: audit a locally exported native Cubism model through the trusted Core.
//   node model-work/hiyori-cubism/tools/audit-export.mjs --model <local.model3.json> --out <local-report.json>
//        [--poses <poses.json>] [--baseline <previous-report.json>] [--require-pose-change]
// Exit codes: 0 ok, 2 audit failure, 3 --require-pose-change not met, 64 usage.
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runAudit, sha256, LIMITATIONS} from '../src/export-audit.mjs';

const HELP = `Native Cubism export audit (raw Core measurement, local only)

Usage:
  node model-work/hiyori-cubism/tools/audit-export.mjs --model <local.model3.json> --out <local-report.json>
       [--poses <poses.json>] [--baseline <previous-report.json>] [--require-pose-change]

Options:
  --model <file>          model3.json of a local export. References resolve from its directory only.
  --out <file>            report JSON to write. Must not be the model, a referenced asset, the poses or the baseline file.
  --poses <file>          {"version":1,"poses":[{"name":"head-turn","parameters":{"ParamAngleX":15}}]}
                          At most 12 unique poses. Unknown parameters or out-of-range values are errors.
  --baseline <file>       earlier report to compare against (same Core and same pose inputs required).
  --require-pose-change   exit 3 unless a requested pose's actual geometry differs from the baseline.
  --help                  show this text.

Core: the trusted file loaded by model-work/hiyori-v2/src/cubism-core-node.mjs (third-party/live2d/, ignored).
Exported model code is never loaded; only declared files are hashed and the moc3 is read by Core.

Evidence limits:
${LIMITATIONS.map(l => `  - ${l}`).join('\n')}
`;

export function parseArgs(argv) {
  const opts = {requirePoseChange: false};
  const takes = {'--model': 'modelPath', '--out': 'outPath', '--poses': 'posesPath', '--baseline': 'baselinePath'};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return {help: true};
    if (arg === '--require-pose-change') { opts.requirePoseChange = true; continue; }
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    const key = takes[flag];
    if (!key) return {error: `unknown option ${flag}`};
    const value = inline ?? argv[++i];
    if (!value) return {error: `${flag} needs a value`};
    opts[key] = value;
  }
  return opts;
}

async function loadTrustedCore() {
  const {loadCubismCore, corePath} = await import('../../hiyori-v2/src/cubism-core-node.mjs');
  const bytes = await readFile(corePath);
  return {core: await loadCubismCore(), sha256: sha256(bytes)};
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); return 0; }
  if (opts.error) { process.stderr.write(`E_USAGE: ${opts.error}\n(see --help)\n`); return 64; }
  const {report, exitCode, writeTo} = await runAudit({...opts, loadCore: loadTrustedCore});
  if (writeTo) await writeFile(writeTo, JSON.stringify(report, null, 2) + '\n');
  for (const e of report.errors) process.stderr.write(`${e.code}${e.ref ? ` ${e.ref}` : ''}${e.detail ? `: ${e.detail}` : ''}\n`);
  const c = report.comparison;
  process.stdout.write(`status=${report.status} coreCompatible=${report.coreCompatible} references=${report.references.length}`
    + ` poses=${report.poses.length}${c ? ` comparison=${c.classification} editProof=${c.editProof}` : ''}`
    + `${writeTo ? ` report=${path.basename(writeTo)}` : ' report=not-written'}\n`);
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, () => { process.stderr.write('E_INTERNAL\n'); process.exitCode = 2; });
}
