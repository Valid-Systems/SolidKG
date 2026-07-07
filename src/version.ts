import * as fs from 'fs';
import * as path from 'path';

export const SOLIDKG_VERSION_METADATA_KEY = 'solidkg:version';

function packageJsonCandidates(): string[] {
  return [
    path.resolve(__dirname, '..', 'package.json'),
    path.resolve(__dirname, '..', '..', 'package.json'),
  ];
}

function readPackageVersion(): string {
  for (const candidate of packageJsonCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    const parsed: unknown = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    if (typeof parsed === 'object'
      && parsed !== null
      && 'version' in parsed
      && typeof parsed.version === 'string'
      && parsed.version.length > 0) {
      return parsed.version;
    }
  }
  return 'unknown';
}

export const SOLIDKG_VERSION = readPackageVersion();
