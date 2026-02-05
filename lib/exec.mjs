import { execSync } from 'child_process';

export function exec(cmd, options = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      stdio: options.silent ? 'pipe' : ['pipe', 'pipe', 'inherit'],
      ...options
    }).trim();
  } catch (error) {
    if (options.ignoreError) {
      return '';
    }
    throw error;
  }
}
