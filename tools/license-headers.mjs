/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';

const COPYRIGHT = 'Copyright 2026 J3nna Technologies, LLC';
const SPDX = 'SPDX-License-Identifier: Apache-2.0';
const FIX = process.argv.includes('--fix');
const COMMENTABLE_EXTENSIONS = new Set([
  '.cjs', '.css', '.html', '.js', '.mjs', '.sh', '.ts', '.tsx', '.yaml', '.yml',
]);
const EXCLUDED_PREFIXES = ['dist/', 'node_modules/', 'vendor/'];

const trackedFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
}).trim().split('\n').filter(Boolean);

const sourceFiles = trackedFiles.filter((file) =>
  existsSync(file) &&
  COMMENTABLE_EXTENSIONS.has(extname(file)) &&
  !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)) &&
  !file.includes('/vendor/'));

const headerFor = (file) => {
  const extension = extname(file);
  if (extension === '.html') return `<!--\n  ${COPYRIGHT}\n  ${SPDX}\n-->\n`;
  if (extension === '.yml' || extension === '.yaml' || extension === '.sh') {
    return `# ${COPYRIGHT}\n# ${SPDX}\n`;
  }
  return `/*\n * ${COPYRIGHT}\n * ${SPDX}\n */\n`;
};

const missing = [];
for (const file of sourceFiles) {
  const contents = readFileSync(file, 'utf8');
  if (contents.includes(SPDX) && contents.includes(COPYRIGHT)) continue;
  missing.push(file);
  if (!FIX) continue;

  const header = headerFor(file);
  if (contents.startsWith('#!')) {
    const newline = contents.indexOf('\n');
    const shebang = newline === -1 ? contents : contents.slice(0, newline);
    const body = newline === -1 ? '' : contents.slice(newline + 1);
    writeFileSync(file, `${shebang}\n${header}\n${body}`);
  } else {
    writeFileSync(file, `${header}\n${contents}`);
  }
}

if (missing.length && !FIX) {
  console.error(`Missing Apache-2.0 source headers (${missing.length}):\n${missing.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`${FIX ? 'Applied' : 'Verified'} Apache-2.0 source headers for ${sourceFiles.length} files.`);
}
