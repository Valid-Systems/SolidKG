import fs from 'node:fs';
import path from 'node:path';

const binDir = path.resolve('dist/bin');

if (fs.existsSync(binDir)) {
  for (const entry of fs.readdirSync(binDir)) {
    if (!entry.endsWith('.js')) continue;
    const file = path.join(binDir, entry);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const filtered = lines.filter((line, index) => index === 0 || !/^\s*\/\/[#@]\s*sourceMappingURL=/.test(line));
    fs.writeFileSync(file, filtered.join('\n'));
  }
}
