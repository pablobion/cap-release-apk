import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Percorre de startDir para cima procurando raiz do projeto Capacitor.
 * Critérios: capacitor.config.{ts,js,json} OU pasta android/ OU package.json na mesma pasta.
 */
export function findProjectRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (true) {
    const hasCapacitorConfig =
      fs.existsSync(path.join(dir, 'capacitor.config.ts')) ||
      fs.existsSync(path.join(dir, 'capacitor.config.js')) ||
      fs.existsSync(path.join(dir, 'capacitor.config.json'));
    const hasAndroid = fs.existsSync(path.join(dir, 'android'));
    const hasPackageJson = fs.existsSync(path.join(dir, 'package.json'));

    if (hasCapacitorConfig || hasAndroid || hasPackageJson) {
      // Prefer directory that has capacitor config or android; package.json alone is fallback only if at cwd
      if (hasCapacitorConfig || hasAndroid) return dir;
      // if only package.json, check if parent also has indicators — still return it as root if no better found above
      // but continue searching upward for a more specific root
      // To avoid false positive deep inside, return nearest package.json if no capacitor/android found higher
    }

    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fallback: search again only for any of the indicators (including package.json)
  dir = path.resolve(startDir);
  while (true) {
    const hasAny =
      fs.existsSync(path.join(dir, 'capacitor.config.ts')) ||
      fs.existsSync(path.join(dir, 'capacitor.config.js')) ||
      fs.existsSync(path.join(dir, 'capacitor.config.json')) ||
      fs.existsSync(path.join(dir, 'android')) ||
      fs.existsSync(path.join(dir, 'package.json'));
    if (hasAny) return dir;
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

export function fileExists(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function dirExists(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Garante que .gitignore em `dir` contenha as linhas necessárias.
 * Descomenta se estiver comentado (ex: "# *.jks").
 */
export function ensureGitignore(dir, requiredLines = ['*.jks', '*.keystore', 'keystore.properties']) {
  const gitignorePath = path.join(dir, '.gitignore');
  let content = '';
  let lines = [];

  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf8');
    lines = content.split(/\r?\n/);
  }

  let changed = false;

  for (const required of requiredLines) {
    const escaped = required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existsExact = lines.some((l) => l.trim() === required);
    if (existsExact) continue;

    // procura linha comentada correspondente
    const commentedIdx = lines.findIndex((l) => {
      const t = l.trim();
      // casa "# *.jks", "#*.jks", "# *.keystore" etc
      return new RegExp(`^#\\s*${escaped}\\s*$`).test(t);
    });

    if (commentedIdx !== -1) {
      lines[commentedIdx] = required;
      changed = true;
    } else {
      // adiciona ao final
      lines.push(required);
      changed = true;
    }
  }

  if (changed) {
    // remove linhas vazias duplicadas no final e garante newline final
    let newContent = lines.join('\n');
    // normaliza múltiplas quebras
    newContent = newContent.replace(/\n{3,}/g, '\n\n');
    if (!newContent.endsWith('\n')) newContent += '\n';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(gitignorePath, newContent, 'utf8');
  }

  return changed;
}

export function getPackageJson(projectRoot) {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return { pkg: null, pkgPath };
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    return { pkg, pkgPath };
  } catch {
    return { pkg: null, pkgPath };
  }
}

export function detectBuildScript(projectRoot) {
  const { pkg } = getPackageJson(projectRoot);
  if (!pkg) return false;
  return Boolean(pkg.scripts && pkg.scripts.build);
}

export function runCommand(cmd, args = [], opts = {}) {
  const res = spawnSync(cmd, args, {
    stdio: opts.stdio ?? 'inherit',
    cwd: opts.cwd,
    shell: opts.shell ?? false,
    encoding: 'utf8',
  });
  return res;
}

export function whichCommand(cmd) {
  const isWin = process.platform === 'win32';
  const which = isWin ? 'where' : 'which';
  const r = spawnSync(which, [cmd], { encoding: 'utf8', stdio: 'pipe' });
  return r.status === 0;
}

/**
 * Tenta encontrar arquivo keystore com tolerância de extensão.
 * - se existe em absolutePath -> retorna ele
 * - se absolutePath termina com .jks ou .keystore -> tenta sem extensão
 * - se não tem extensão -> tenta adicionando .jks e .keystore
 * - senão retorna null
 */
export function findKeystoreFile(absolutePath) {
  if (!absolutePath) return null;
  const abs = path.normalize(String(absolutePath).trim());
  if (!abs) return null;

  // helper file check (isFile)
  const isFile = (p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
      return fs.existsSync(p);
    }
  };

  if (isFile(abs)) return abs;

  const lower = abs.toLowerCase();
  const isJks = lower.endsWith('.jks');
  const isKeystore = lower.endsWith('.keystore');

  if (isJks || isKeystore) {
    const withoutExt = abs.replace(/\.(jks|keystore)$/i, '');
    if (isFile(withoutExt)) return withoutExt;
    return null;
  }

  // sem extensão conhecida -> tenta com .jks e .keystore
  const withJks = abs + '.jks';
  if (isFile(withJks)) return withJks;
  const withKeystore = abs + '.keystore';
  if (isFile(withKeystore)) return withKeystore;
  return null;
}

/**
 * Retorna lista de caminhos alternativos que seriam tentados por findKeystoreFile
 * (sem verificar existência, apenas para mensagem de erro)
 */
export function getKeystoreFallbackPaths(absolutePath) {
  if (!absolutePath) return [];
  const abs = path.normalize(String(absolutePath).trim());
  if (!abs) return [];
  const lower = abs.toLowerCase();
  if (lower.endsWith('.jks') || lower.endsWith('.keystore')) {
    const withoutExt = abs.replace(/\.(jks|keystore)$/i, '');
    return [withoutExt];
  }
  return [abs + '.jks', abs + '.keystore'];
}

/**
 * Resolve storeFile input to absolute path.
 * - if absolute -> normalized absolute
 * - else if startsWith "android/" or "android\" -> join projectRoot + storeFile
 * - else if contains "/" or "\" -> join projectRoot + storeFile (relative to root)
 * - else (bare filename) -> join projectRoot + storeFile (project root, NOT android/app)
 */
export function resolveKeystorePath(storeFile, projectRoot) {
  if (!storeFile) return storeFile;
  const input = String(storeFile).trim();
  if (!input) return input;
  if (path.isAbsolute(input)) {
    return path.normalize(input);
  }
  if (input.startsWith('android/') || input.startsWith('android\\')) {
    return path.normalize(path.join(projectRoot, input));
  }
  if (input.includes('/') || input.includes('\\')) {
    return path.normalize(path.join(projectRoot, input));
  }
  // bare filename like my-keystore.jks -> project root
  return path.normalize(path.join(projectRoot, input));
}

/**
 * Returns path to store in android/keystore.properties:
 * - Compute relative from androidDir (projectRoot/android) to absolutePath
 * - If absolutePath is inside projectRoot, return relative (e.g. ../my-keystore.jks or app/release.jks)
 * - If absolutePath is outside projectRoot, return absolute (with forward slashes)
 * Always uses forward slashes for gradle.
 */
export function getStoreFileForProperties(absolutePath, projectRoot) {
  if (!absolutePath) return absolutePath;
  const abs = path.isAbsolute(absolutePath) ? path.normalize(absolutePath) : path.normalize(path.resolve(projectRoot, absolutePath));
  const androidDir = path.join(projectRoot, 'android');
  // Determine if abs is inside projectRoot
  const relToRoot = path.relative(projectRoot, abs);
  const isOutside =
    relToRoot === '' ? false :
    relToRoot.startsWith('..' + path.sep) || relToRoot === '..' || path.isAbsolute(relToRoot);
  // Also detect Windows different drive where relative is absolute
  if (isOutside) {
    return abs.replace(/\\/g, '/');
  }
  const relToAndroid = path.relative(androidDir, abs);
  // path.relative can return '' if same dir; but keystore is file so shouldn't be empty
  // If for some reason relToAndroid is absolute (different drive), fallback to absolute
  if (path.isAbsolute(relToAndroid)) {
    return abs.replace(/\\/g, '/');
  }
  return relToAndroid.replace(/\\/g, '/');
}
