import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Config, Fault, configSchema } from './model.js';

export interface Profile { name: string; path: string }
const validName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function profilePath(name: string, directory = resolve(process.cwd(), 'profiles')): string {
  if (!validName.test(name)) throw new Fault('configuration', 'Profile name must contain 1–64 letters, digits, underscores, or hyphens, starting with a letter or digit');
  return resolve(directory, `${name}.json`);
}
export function listProfiles(directory = resolve(process.cwd(), 'profiles')): Profile[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(file => file.endsWith('.json') && validName.test(file.slice(0, -5)) && lstatSync(resolve(directory, file)).isFile())
    .sort().map(file => ({ name: file.slice(0, -5), path: resolve(directory, file) }));
}
export function resolveProfile(name: string, directory?: string): string {
  const path = profilePath(name, directory);
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Fault('configuration', 'Profile not found; check the profiles directory or run setup to create one');
  return path;
}
export function saveProfile(name: string, config: Config, directory = resolve(process.cwd(), 'profiles')): Profile {
  const path = profilePath(name, directory);
  const validated = configSchema.safeParse(config);
  if (!validated.success) throw new Fault('configuration', 'Invalid profile configuration');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (e) { throw new Fault('configuration', (e as NodeJS.ErrnoException).code === 'EEXIST' ? 'Profile already exists; choose a new name' : 'Profile could not be created'); }
  try { writeFileSync(fd, JSON.stringify(validated.data, null, 2) + '\n'); }
  catch { unlinkSync(path); throw new Fault('configuration', 'Profile could not be saved'); }
  finally { closeSync(fd); }
  return { name, path };
}
