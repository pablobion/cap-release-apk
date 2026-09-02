import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { findProjectRoot, fileExists, detectBuildScript, findKeystoreFile, getKeystoreFallbackPaths, getStoreFileForProperties } from './utils.js';

function formatMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

function tailLines(text, n) {
  if (!text) return '';
  const lines = String(text).split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

function combinedOutput(res) {
  const out = (res.stdout || '').toString();
  const err = (res.stderr || '').toString();
  if (out && err) return out + '\n' + err;
  return out || err || '';
}

export async function build(opts = {}) {
  const debug = Boolean(opts.debug);
  const verbose = Boolean(opts.verbose);

  const modeLabel = debug ? 'debug (APK)' : 'release (APK)';
  const gradleTask = debug ? 'assembleDebug' : 'assembleRelease';
  const gradleTasks = [gradleTask];
  const expectedRel = debug ? 'app/build/outputs/apk/debug/app-debug.apk' : 'app/build/outputs/apk/release/app-release.apk';
  const expectedOutDir = 'dist-apk';
  const expectedOutFile = debug ? 'app-debug.apk' : 'app-release.apk';
  const artifactLabel = debug ? 'APK debug' : 'APK release';

  p.intro(`CapReleaseAPK build ${modeLabel}`);

  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) {
    p.log.error('Raiz do projeto não encontrada. Execute dentro de um projeto Capacitor (com capacitor.config.* ou android/).');
    p.outro('Build cancelado.');
    process.exitCode = 1;
    return;
  }
  p.log.info(`Projeto: ${projectRoot}`);

  const androidDir = path.join(projectRoot, 'android');
  const gradlewName = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  const gradlewPath = path.join(androidDir, gradlewName);

  const s = p.spinner();

  // 1) Doctor checks rápidas
  s.start('Verificando ambiente...');
  const checks = [];
  let pendingCorrection = null;
  if (!fs.existsSync(androidDir)) checks.push('pasta android/ não encontrada');
  if (!fileExists(gradlewPath)) checks.push(`${gradlewName} não encontrado`);
  const ksProps = path.join(androidDir, 'keystore.properties');
  if (!debug && !fileExists(ksProps)) {
    checks.push('android/keystore.properties não encontrado (necessário para release)');
  } else if (!debug && fileExists(ksProps)) {
    // Validate storeFile path inside keystore.properties com tolerância de extensão
    try {
      const c = fs.readFileSync(ksProps, 'utf8');
      const lines = c.split(/\r?\n/);
      const getVal = (k) => {
        const line = lines.find((l) => l.trim().startsWith(k + '='));
        return line ? line.split('=').slice(1).join('=').trim() : '';
      };
      const storeFile = getVal('storeFile');
      if (storeFile) {
        let ksAbsolute;
        if (path.isAbsolute(storeFile)) {
          ksAbsolute = path.normalize(storeFile);
        } else {
          ksAbsolute = path.normalize(path.resolve(androidDir, storeFile));
        }
        const requestedAbs = ksAbsolute;
        let actualPath = findKeystoreFile(requestedAbs);
        const isBare = !storeFile.includes('/') && !storeFile.includes('\\');
        let altBare = null;
        if (!actualPath && isBare) {
          altBare = path.normalize(path.join(projectRoot, storeFile));
          if (altBare !== requestedAbs) {
            const altActual = findKeystoreFile(altBare);
            if (altActual) actualPath = altActual;
          }
        }
        if (actualPath && path.normalize(actualPath) !== path.normalize(requestedAbs)) {
          // Auto-corrige keystore.properties para gradle encontrar o arquivo real
          const newStoreFile = getStoreFileForProperties(actualPath, projectRoot);
          try {
            const raw = fs.readFileSync(ksProps, 'utf8');
            const updated = raw.replace(/^storeFile\s*=.*$/m, `storeFile=${newStoreFile}`);
            if (updated !== raw) {
              fs.writeFileSync(ksProps, updated, 'utf8');
            } else {
              // fallback: rewrite entire file if regex não pegou
              const newLines = raw.split(/\r?\n/).map((l) => (l.trim().startsWith('storeFile=') ? `storeFile=${newStoreFile}` : l));
              fs.writeFileSync(ksProps, newLines.join('\n'), 'utf8');
            }
            pendingCorrection = `▲ Corrigido keystore.properties: ${storeFile} -> ${newStoreFile} (arquivo real: ${actualPath})`;
          } catch (e) {
            pendingCorrection = `Keystore encontrado via fallback em ${actualPath} mas falha ao corrigir keystore.properties: ${e.message}`;
          }
        } else if (!actualPath) {
          const fallbacks = getKeystoreFallbackPaths(requestedAbs);
          let allFallbacks = [...fallbacks];
          if (isBare && altBare && altBare !== requestedAbs) {
            if (!allFallbacks.includes(altBare)) allFallbacks.unshift(altBare);
            const altFallbacks = getKeystoreFallbackPaths(altBare);
            for (const f of altFallbacks) if (!allFallbacks.includes(f)) allFallbacks.push(f);
          }
          const triedStr = allFallbacks.length ? ` (tentou também ${allFallbacks.join(', ')})` : '';
          checks.push(`Keystore não encontrado em ${requestedAbs}${triedStr} (storeFile=${storeFile})`);
        }
      }
    } catch {}
  }
  const gradleFile = path.join(androidDir, 'app', 'build.gradle');
  if (!fileExists(gradleFile)) checks.push('android/app/build.gradle não encontrado');

  // java check rápido
  const javaCheck = spawnSync('java', ['-version'], { encoding: 'utf8', stdio: 'pipe' });
  const javaOut = (javaCheck.stderr || javaCheck.stdout || '').toString();
  if (javaCheck.error || (!javaOut && javaCheck.status !== 0)) {
    checks.push('java não encontrado (JDK 17+ necessário)');
  }

  if (checks.length) {
    s.stop('Verificação falhou');
    for (const c of checks) p.log.error(c);
    p.log.warn('Dica: rode "npx cap-release-apk doctor" para diagnóstico completo.');
    p.outro('Build cancelado.');
    process.exitCode = 1;
    return;
  }
  s.stop('Ambiente ok ✓');
  if (pendingCorrection) p.log.warn(pendingCorrection);
  if (javaOut) {
    const firstLine = javaOut.trim().split('\n')[0];
    p.log.info(`Java: ${firstLine}`);
  }

  // 2) npm run build
  if (detectBuildScript(projectRoot)) {
    s.start('Rodando npm run build...');
    const res = spawnSync('npm', ['run', 'build'], {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (res.status !== 0) {
      s.stop('npm run build falhou');
      p.log.error('Falha no "npm run build". Corrija os erros acima.');
      p.outro('Build cancelado.');
      process.exitCode = res.status || 1;
      return;
    }
    s.stop('npm run build concluído ✓');
  } else {
    p.log.warn('Nenhum script "build" encontrado em package.json — pulando etapa de build web.');
  }

  // 3) npx cap sync android
  s.start('Sincronizando Capacitor (npx cap sync android)...');
  let syncRes = spawnSync('npx', ['cap', 'sync', 'android'], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (syncRes.status !== 0) {
    p.log.warn('cap sync android falhou, tentando "npx cap sync"...');
    syncRes = spawnSync('npx', ['cap', 'sync'], {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (syncRes.status !== 0) {
      s.stop('cap sync falhou');
      p.log.error('Falha no cap sync. Verifique a configuração do Capacitor.');
      p.outro('Build cancelado.');
      process.exitCode = syncRes.status || 1;
      return;
    }
  }
  s.stop('Capacitor sync concluído ✓');

  // 4) gradlew tasks
  const taskDisplay = gradleTasks.join(' ');
  s.start(`Gerando ${artifactLabel} (${taskDisplay}) — isso pode levar alguns minutos...`);

  // garante permissão de execução no *nix
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(gradlewPath, 0o755);
    } catch {}
  }

  if (!fileExists(gradlewPath)) {
    s.stop('gradlew não encontrado');
    p.log.error(`Não encontrado: ${gradlewPath}`);
    p.outro('Build cancelado.');
    process.exitCode = 1;
    return;
  }

  // Executa Gradle com captura de saída para diagnóstico (timeout 300s)
  const gradleArgs = [...gradleTasks, '--stacktrace'];
  if (verbose) gradleArgs.push('--info');
  const gradleCmdDisplay = `${gradlewName} ${gradleArgs.join(' ')}`;

  const gradleRes = spawnSync(gradlewPath, gradleArgs, {
    cwd: androidDir,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 300_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (gradleRes.error || gradleRes.status !== 0) {
    s.stop(`Gradle ${taskDisplay} falhou`);

    // Diagnóstico detalhado
    const output = combinedOutput(gradleRes);
    const last80 = tailLines(output, 80);

    p.log.error(`Falha ao executar ${gradlewName} ${taskDisplay}`);
    p.log.error(`Comando: ${gradleCmdDisplay}`);
    p.log.error(`Diretório: ${androidDir}`);
    if (gradleRes.error) {
      p.log.error(`Erro spawn: ${gradleRes.error.message}`);
      if (gradleRes.error.code === 'ETIMEDOUT') {
        p.log.error('Timeout de 300s excedido — Gradle travou ou demorou demais.');
      }
    }
    if (gradleRes.signal) p.log.error(`Sinal: ${gradleRes.signal}`);
    if (gradleRes.status !== null && gradleRes.status !== undefined) p.log.error(`Exit code: ${gradleRes.status}`);

    if (output) {
      p.log.error('--- Saída do Gradle (últimas 80 linhas) ---');
      const textToShow = verbose ? output : last80;
      const linesToPrint = String(textToShow).split(/\r?\n/);
      const limit = verbose ? 200 : 80;
      const slice = linesToPrint.slice(-limit);
      for (const line of slice) {
        p.log.error(line);
      }
      if (!verbose && linesToPrint.length > 80) {
        p.log.warn(`(saída completa tem ${linesToPrint.length} linhas — rode com --verbose para ver mais, ou veja acima)`);
      }
      p.log.error('--- Fim da saída do Gradle ---');
    } else {
      p.log.error('(nenhuma saída capturada do Gradle — verifique se gradlew.bat tem permissão e se Java está no PATH)');
    }

    // Hints práticos
    p.log.warn('Dicas de diagnóstico:');
    p.log.warn('  • keystore: verifique android/keystore.properties → storeFile existe? Caminho relativo a android/ (ex: ../my-keystore.jks ou app/release.jks). Use rootProject.file() no build.gradle.');
    p.log.warn('  • keyAlias é case-sensitive; confira com: keytool -list -keystore <arquivo> -storepass <senha>');
    p.log.warn('  • senhas: storePassword e keyPassword — teste com keytool; caracteres especiais podem precisar escapar');
    p.log.warn('  • sdk.dir: verifique android/local.properties e ANDROID_HOME/ANDROID_SDK_ROOT');
    p.log.warn('  • Java: java -version deve ser JDK 17+ (Gradle 8 + AGP 8). Atual: ' + (javaOut ? javaOut.trim().split('\n')[0] : 'desconhecido'));
    p.log.warn('  • wrapper: verifique android/gradle/wrapper/gradle-wrapper.properties (distributionUrl) — tente atualizar wrapper');
    p.log.warn('  • lock/artefato: tente .\\gradlew.bat clean  em android/ e feche APK aberto no Explorer/antivírus');
    p.log.warn(`  • rerun verboso: .\\gradlew.bat ${taskDisplay} --stacktrace --info > gradle.log 2>&1`);
    if (!verbose) p.log.info('Dica: rode novamente com --verbose para saída completa: npx cap-release-apk build --verbose');

    p.outro('Build cancelado.');
    if (gradleRes.status !== null && gradleRes.status !== 0) process.exitCode = gradleRes.status;
    else if (gradleRes.error) process.exitCode = 1;
    else process.exitCode = 1;
    return;
  }
  // Sucesso: se verbose, mostra saída também
  if (verbose) {
    const out = combinedOutput(gradleRes);
    if (out) {
      p.log.info('--- Saída do Gradle ---');
      const lines = String(out).split(/\r?\n/).slice(-40);
      for (const l of lines) p.log.info(l);
      p.log.info('--- Fim saída ---');
    }
  }
  s.stop(`Gradle ${taskDisplay} concluído ✓`);

  // 5) Localiza e copia artefato
  const srcPath = path.join(androidDir, expectedRel);
  if (!fileExists(srcPath)) {
    p.log.error(`${artifactLabel} não encontrado em ${srcPath}`);
    p.log.warn('Verifique a saída do Gradle acima por erros de signing ou build.');
    p.outro('Build finalizado com aviso.');
    process.exitCode = 1;
    return;
  }
  const stat = fs.statSync(srcPath);
  const sizeMB = formatMB(stat.size);
  const sizeBytes = stat.size;

  try {
    const outDir = path.join(projectRoot, expectedOutDir);
    fs.mkdirSync(outDir, { recursive: true });
    const dest = path.join(outDir, expectedOutFile);
    fs.copyFileSync(srcPath, dest);
    p.log.success(`${artifactLabel} gerado: ${srcPath} (${sizeMB} MB)`);
    p.log.success(`Cópia em: ${dest}`);
    p.note(`${dest}\n${sizeMB} MB (${sizeBytes} bytes) • ${artifactLabel}`, `${artifactLabel} pronto`);
  } catch (e) {
    p.log.warn(`Falha ao copiar ${artifactLabel} para ${expectedOutDir}/: ${e.message}`);
    p.log.success(`${artifactLabel} gerado: ${srcPath} (${sizeMB} MB)`);
    p.note(`${srcPath}\n${sizeMB} MB (${sizeBytes} bytes) • ${artifactLabel}`, `${artifactLabel} pronto`);
  }

  p.outro('Build concluído com sucesso! 🎉');
}
