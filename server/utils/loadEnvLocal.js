import fs from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const parseEnvLocal = (content) => {
  const lines = content.split(/\r?\n/);
  const entries = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;

    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!key) continue;
    entries.push([key, value]);
  }

  return entries;
};

/**
 * Load .env.local from repo root into process.env.
 * Intentionally minimal replacement for dotenv to avoid extra dependency.
 */
export async function loadEnvLocal() {
  try {
    const repoRoot = join(__dirname, '../..');
    const envPath = join(repoRoot, '.env.local');
    const content = await fs.readFile(envPath, 'utf-8');

    for (const [key, value] of parseEnvLocal(content)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // ignore missing .env.local
  }
}
