// Scan git-visible source only; report filenames/line numbers, never credential values.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const patterns = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}/, /\bAIza[0-9A-Za-z_-]{35}\b/, /"private_key"\s*:\s*"-----/];
let hits = 0;
for (const file of files) {
  if (/\.(png|jpg|ico|pdf|lock)$/.test(file) || file.endsWith('secrets-check.ts')) continue;
  let content; try { content = readFileSync(file, 'utf8'); } catch { continue; }
  content.split('\n').forEach((line, n) => { if (patterns.some(p => p.test(line))) { console.error(`${file}:${n+1}: possible credential; review locally`); hits++; } });
}
console.log(`Scanned ${files.length} git-visible files; ${hits} potential credentials. Pattern scan is not a guarantee.`);
process.exitCode = hits ? 1 : 0;
