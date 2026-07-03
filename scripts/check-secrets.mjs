#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const forbidden = ['API.txt', '.env'];
const tracked = new Set(
  execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean),
);

const offenders = forbidden.filter((path) => tracked.has(path));
if (offenders.length > 0) {
  console.error(`Secret/local files must not be tracked: ${offenders.join(', ')}`);
  process.exit(1);
}

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((path) => existsSync(path));

const suspicious = [/sk-[A-Za-z0-9_-]{20,}/];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const pattern of suspicious) {
    if (pattern.test(text)) {
      console.error(`Possible secret pattern in ${file}`);
      process.exit(1);
    }
  }
}

console.log('Secret check passed.');
