import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { findProjectRoot, fileExists, dirExists, resolveKeystorePath, getStoreFileForProperties, findKeystoreFile, getKeystoreFallbackPaths } from './utils.js';

function checkJava() {
  const res = spawnSync('java', ['-version'], { encoding: 'utf8', stdio: 'pipe' });
  // java -version sai em stderr
  const output = (res.stderr || res.stdout || '').toString();
  if (res.error && res.error.code === 'ENOENT') {
    return { ok: false, detail: 'java não encontrado no PATH' };
  }
  if (res.status !== 0 && !output) {
    return { ok: false, detail: 'java não encontrado ou erro ao executar' };
  }
  // extrai versão: "17.0.8", "21.0.1", "1.8.0_302"
  const match = output.match(/version\s+"([^"]+)"/);
  const versionStr = match ? match[1] : output.trim().split('\n')[0] || 'desconhecida';
  let major = null;
  if (match) {
    const v = match[1];
    if (v.startsWith('1.')) {
      major = parseInt(v.split('.')[1], 10);
    } else {
      major = parseInt(v.split('.')[0], 10);
    }
  }
  const ok = major === null ? true : major >= 17;
  let detail = `versão ${versionStr}`;
  if (major !== null && major < 17) detail += ' (recomendado JDK 17+ para AGP 8+)';
  return { ok, detail, major, raw: output };
}

function checkKeytool() {
  const res = spawnSync('keytool', ['-help'], { encoding: 'utf8', stdio: 'pipe' });
  if (res.error && res.error.code === 'ENOENT') {
    return { ok: false, detail: 'keytool não encontrado (instale JDK)' };
  }
  // algumas instalações retornam status !=0 mas ainda existem; considera ok se não ENOENT
  if (res.error) return { ok: false, detail: res.error.message };
  return { ok: true, detail: 'keytool disponível' };
}

export async function doctor() {
  p.intro('CapReleaseAPK doctor');

  const issues = [];
  const okMessages = [];

  // Node
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor >= 18) {
    okMessages.push(`Node ${process.versions.node} ✓ (≥18)`);
    p.log.success(`Node ${process.versions.node} — ok (≥18)`);
  } else {
    issues.push(`Node ${process.versions.node} — requer Node ≥18`);
    p.log.error(`Node ${process.versions.node} — requer Node ≥18`);
  }

  // java
  const java = checkJava();
  if (java.ok) {
    p.log.success(`Java — ${java.detail}`);
  } else {
    p.log.error(`Java — ${java.detail}`);
    issues.push(`Java: ${java.detail}`);
  }

  // keytool
  const kt = checkKeytool();
  if (kt.ok) p.log.success(`keytool — ${kt.detail}`);
  else {
    p.log.error(`keytool — ${kt.detail}`);
    issues.push(kt.detail);
  }

  // ANDROID_HOME / sdk dir
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (androidHome) {
    if (fs.existsSync(androidHome)) p.log.success(`ANDROID_HOME — ${androidHome}`);
    else {
      p.log.warn(`ANDROID_HOME aponta para caminho inexistente: ${androidHome}`);
      issues.push(`ANDROID_HOME inexistente: ${androidHome}`);
    }
  } else {
    p.log.warn('ANDROID_HOME / ANDROID_SDK_ROOT não definido');
    // verifica local.properties
    const root = findProjectRoot(process.cwd());
    if (root) {
      const localProps = path.join(root, 'android', 'local.properties');
      if (fs.existsSync(localProps)) {
        const c = fs.readFileSync(localProps, 'utf8');
        if (c.includes('sdk.dir')) p.log.success('sdk.dir encontrado em android/local.properties');
        else {
          p.log.warn('sdk.dir não encontrado em android/local.properties');
          issues.push('sdk.dir ausente em android/local.properties e ANDROID_HOME não definido');
        }
      } else {
        p.log.warn('android/local.properties não encontrado e ANDROID_HOME não definido');
        issues.push('ANDROID_HOME não definido e local.properties ausente');
      }
    } else {
      issues.push('ANDROID_HOME não definido');
    }
  }

  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) {
    p.log.error('Raiz do projeto não encontrada (capacitor.config.* ou android/ ou package.json)');
    issues.push('Raiz do projeto não encontrada');
  } else {
    p.log.success(`Projeto — ${projectRoot}`);

    // android folder
    const androidDir = path.join(projectRoot, 'android');
    if (dirExists(androidDir)) p.log.success('android/ — existe');
    else {
      p.log.error('android/ — não encontrado (rode npx cap add android)');
      issues.push('android/ não encontrado');
    }

    // gradlew
    const gradlewName = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
    const gradlewPath = path.join(androidDir, gradlewName);
    if (fileExists(gradlewPath)) p.log.success(`${gradlewName} — existe`);
    else {
      p.log.error(`${gradlewName} não encontrado em android/`);
      issues.push(`${gradlewName} não encontrado`);
    }

    // capacitor.config
    const hasCapConfig =
      fs.existsSync(path.join(projectRoot, 'capacitor.config.ts')) ||
      fs.existsSync(path.join(projectRoot, 'capacitor.config.js')) ||
      fs.existsSync(path.join(projectRoot, 'capacitor.config.json'));
    if (hasCapConfig) p.log.success('capacitor.config.* — encontrado');
    else {
      p.log.warn('capacitor.config.* — não encontrado');
      issues.push('capacitor.config.* não encontrado');
    }

    // keystore.properties
    const ksProps = path.join(androidDir, 'keystore.properties');
    if (fileExists(ksProps)) {
      p.log.success('android/keystore.properties — existe');
      try {
        const c = fs.readFileSync(ksProps, 'utf8');
        const lines = c.split(/\r?\n/);
        const getVal = (k) => {
          const line = lines.find((l) => l.trim().startsWith(k + '='));
          return line ? line.split('=').slice(1).join('=').trim() : '';
        };
        const storeFile = getVal('storeFile');
        const storePassword = getVal('storePassword');
        const keyAlias = getVal('keyAlias');
        const keyPassword = getVal('keyPassword');
        if (!storeFile || !storePassword || !keyAlias || !keyPassword) {
          p.log.warn('keystore.properties incompleto (faltam campos)');
          issues.push('keystore.properties incompleto');
        } else {
          // Resolve storeFile correctly: relative to android/ (handles ../, app/, absolute). Bare filename -> project root (backward compat)
          const androidDirResolved = path.join(projectRoot, 'android');
          let ksAbsolute;
          if (path.isAbsolute(storeFile)) {
            ksAbsolute = path.normalize(storeFile);
          } else {
            ksAbsolute = path.normalize(path.resolve(androidDirResolved, storeFile));
          }
          // Tenta com tolerância de extensão (.jks/.keystore)
          const requestedAbs = ksAbsolute;
          let actualPath = findKeystoreFile(requestedAbs);
          // Fallback legacy para bare filename: tenta também na raiz do projeto
          const isBare = !storeFile.includes('/') && !storeFile.includes('\\');
          let altBare = null;
          if (!actualPath && isBare) {
            altBare = path.normalize(path.join(projectRoot, storeFile));
            if (altBare !== requestedAbs) {
              const altActual = findKeystoreFile(altBare);
              if (altActual) actualPath = altActual;
            }
          }
          if (actualPath) {
            if (path.normalize(actualPath) !== path.normalize(requestedAbs)) {
              p.log.success(`◆ keystore file — encontrado: ${actualPath} (solicitado: ${requestedAbs})`);
              p.log.warn(`Valor em keystore.properties diverge do arquivo real — considere atualizar storeFile para ${getStoreFileForProperties(actualPath, projectRoot)}`);
            } else {
              p.log.success(`keystore file — encontrado: ${actualPath}`);
            }
          } else {
            const fallbacks = getKeystoreFallbackPaths(requestedAbs);
            let allFallbacks = [...fallbacks];
            if (isBare && altBare && altBare !== requestedAbs) {
              if (!allFallbacks.includes(altBare)) allFallbacks.unshift(altBare);
              const altFallbacks = getKeystoreFallbackPaths(altBare);
              for (const f of altFallbacks) if (!allFallbacks.includes(f)) allFallbacks.push(f);
            }
            const triedStr = allFallbacks.length ? ` (tentou também ${allFallbacks.join(', ')})` : '';
            p.log.warn(`Keystore não encontrado em ${requestedAbs}${triedStr} (valor em keystore.properties: ${storeFile})`);
            issues.push(`Keystore não encontrado em ${requestedAbs}${triedStr}`);
          }
        }
      } catch (e) {
        p.log.error(`Erro ao ler keystore.properties: ${e.message}`);
        issues.push('Erro ao ler keystore.properties');
      }
    } else {
      p.log.warn('android/keystore.properties — não encontrado (rode npx cap-release-apk init)');
      issues.push('keystore.properties não encontrado');
    }

    // build.gradle signingConfigs
    const gradlePath = path.join(androidDir, 'app', 'build.gradle');
    if (fileExists(gradlePath)) {
      const c = fs.readFileSync(gradlePath, 'utf8');
      if (c.includes('signingConfigs') && c.includes('keystoreProperties')) {
        p.log.success('android/app/build.gradle — signingConfigs patchado');
      } else {
        p.log.warn('android/app/build.gradle — sem patch de signingConfigs (rode npx cap-release-apk init)');
        issues.push('build.gradle sem signingConfigs');
      }
    } else {
      p.log.warn('android/app/build.gradle — não encontrado');
      issues.push('build.gradle não encontrado');
    }
  }

  if (issues.length === 0) {
    p.log.success('Doctor: tudo ok ✓');
    p.outro('Nenhum problema encontrado.');
    return 0;
  } else {
    p.log.warn(`Doctor: ${issues.length} problema(s) encontrado(s)`);
    for (const iss of issues) p.log.warn(`  • ${iss}`);
    p.outro('Corrija os itens acima e rode novamente.');
    return 1;
  }
}
