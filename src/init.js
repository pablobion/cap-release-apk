import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { findProjectRoot, fileExists, ensureGitignore, getPackageJson, resolveKeystorePath, getStoreFileForProperties, findKeystoreFile, findAndroidSdk } from './utils.js';
import { patchGradle } from './patch-gradle.js';

function isCancel(value) {
  return p.isCancel(value);
}

export async function init(opts = {}) {
  p.intro('CapReleaseAPK init');

  // Detecta raiz
  let projectRoot = findProjectRoot(process.cwd());

  if (!projectRoot) {
    p.log.warn('Não foi possível detectar a raiz do projeto Capacitor automaticamente.');
    const customPath = await p.text({
      message: 'Informe o caminho da raiz do projeto (onde está capacitor.config.*):',
      placeholder: process.cwd(),
      initialValue: process.cwd(),
      validate: (v) => {
        if (!v || !v.trim()) return 'Caminho obrigatório';
        const dir = path.resolve(v.trim());
        if (!fs.existsSync(dir)) return 'Caminho não existe';
        return undefined;
      },
    });
    if (isCancel(customPath)) {
      p.cancel('Operação cancelada.');
      return;
    }
    const dir = path.resolve(customPath.trim());
    projectRoot = dir;
    // valida que tem pelo menos package.json ou android
    if (!fs.existsSync(path.join(dir, 'package.json')) && !fs.existsSync(path.join(dir, 'android'))) {
      p.log.error(`Caminho ${dir} não parece ser raiz de projeto (sem package.json ou android/).`);
      p.outro('Init cancelado.');
      return;
    }
  }

  p.log.info(`Projeto: ${projectRoot}`);

  // Lê keystore.properties existente para usar como default e checar divergência startup (como doctor)
  // Carrega todas as props relevantes para reuso em --yes
  const androidDirEarly = path.join(projectRoot, 'android');
  const ksPropsPathEarly = path.join(androidDirEarly, 'keystore.properties');
  let existingProps = {};
  let existingStoreFileValue = null;
  if (fs.existsSync(ksPropsPathEarly)) {
    try {
      const rawEarly = fs.readFileSync(ksPropsPathEarly, 'utf8');
      const linesEarly = rawEarly.split(/\r?\n/);
      const getValEarly = (k) => {
        const line = linesEarly.find((l) => l.trim().startsWith(k + '='));
        return line ? line.split('=').slice(1).join('=').trim() : '';
      };
      existingProps.storeFile = getValEarly('storeFile') || undefined;
      existingProps.storePassword = getValEarly('storePassword') || undefined;
      existingProps.keyAlias = getValEarly('keyAlias') || undefined;
      existingProps.keyPassword = getValEarly('keyPassword') || undefined;
      existingProps.dname = getValEarly('dname') || undefined;
      existingProps.validity = getValEarly('validity') || undefined;
      if (existingProps.storeFile) existingStoreFileValue = existingProps.storeFile;
      if (existingStoreFileValue) {
        let requestedAbsEarly;
        if (path.isAbsolute(existingStoreFileValue)) requestedAbsEarly = path.normalize(existingStoreFileValue);
        else requestedAbsEarly = path.normalize(path.resolve(androidDirEarly, existingStoreFileValue));
        let actualEarly = findKeystoreFile(requestedAbsEarly);
        const isBareEarly = !existingStoreFileValue.includes('/') && !existingStoreFileValue.includes('\\');
        if (!actualEarly && isBareEarly) {
          const altBareEarly = path.normalize(path.join(projectRoot, existingStoreFileValue));
          if (altBareEarly !== requestedAbsEarly) {
            const altActualEarly = findKeystoreFile(altBareEarly);
            if (altActualEarly) actualEarly = altActualEarly;
          }
        }
        if (actualEarly && path.normalize(actualEarly) !== path.normalize(requestedAbsEarly)) {
          const correctedEarly = getStoreFileForProperties(actualEarly, projectRoot);
          p.log.warn(`▲ Valor em keystore.properties diverge do arquivo real — considere atualizar storeFile para ${correctedEarly}`);
        }
      }
    } catch {}
  }

  const isYes = Boolean(opts.yes);

  // Coleta valores — prioridade: opts CLI > env vars (quando --yes) > prompts
  const env = process.env;

  let storeFileInput = opts.storeFile || (isYes ? env.CAP_APK_STORE_FILE : undefined);
  let keyAliasInput = opts.keyAlias || (isYes ? env.CAP_APK_KEY_ALIAS : undefined);
  let storePasswordInput = opts.storePassword || (isYes ? env.CAP_APK_STORE_PASSWORD : undefined);
  let keyPasswordInput = opts.keyPassword || (isYes ? env.CAP_APK_KEY_PASSWORD : undefined);
  let dnameInput = opts.dname || (isYes ? env.CAP_APK_DNAME : undefined);
  let validityInput = opts.validity || (isYes ? env.CAP_APK_VALIDITY : undefined);

  // Defaults — se já existe keystore.properties, usa valor existente como default (permite auto-correção ao reaproveitar)
  const defaultStoreFile = existingStoreFileValue || 'android/app/release.jks';
  // alternativa mencionada na spec: dailyfaith.jks — em projeto genérico usamos release.jks
  const defaultAlias = existingProps.keyAlias || 'release';
  const defaultDname = existingProps.dname || 'CN=CapReleaseAPK, OU=Mobile, O=App, C=BR';
  const defaultValidity = existingProps.validity || '10000';

  // Se não é --yes, faz perguntas interativas pulando quem já veio via CLI
  if (!isYes) {
    // storeFile
    if (!storeFileInput) {
      const v = await p.text({
        message: 'Caminho do keystore (storeFile):',
        placeholder: defaultStoreFile,
        initialValue: defaultStoreFile,
        validate: (val) => (!val || !val.trim() ? 'Informe o caminho' : undefined),
      });
      if (isCancel(v)) { p.cancel('Operação cancelada.'); return; }
      storeFileInput = v.trim() || defaultStoreFile;
    }

    // keyAlias
    if (!keyAliasInput) {
      const v = await p.text({
        message: 'Alias da chave (keyAlias):',
        placeholder: defaultAlias,
        initialValue: defaultAlias,
        validate: (val) => (!val || !val.trim() ? 'Informe o alias' : undefined),
      });
      if (isCancel(v)) { p.cancel('Operação cancelada.'); return; }
      keyAliasInput = v.trim() || defaultAlias;
    }

    // storePassword + confirmação (repete ambos até coincidirem)
    if (!storePasswordInput) {
      for (;;) {
        const v = await p.password({
          message: 'Senha do keystore (storePassword) — mínimo 6 caracteres:',
          validate: (val) => {
            if (!val || val.length < 6) return 'Senha deve ter pelo menos 6 caracteres';
            return undefined;
          },
        });
        if (isCancel(v)) { p.cancel('Operação cancelada.'); return; }
        const c = await p.password({
          message: 'Confirme a senha do keystore:',
          validate: () => undefined,
        });
        if (isCancel(c)) { p.cancel('Operação cancelada.'); return; }
        if (v !== c) {
          p.log.error('Senhas não coincidem. Tente novamente.');
          continue;
        }
        storePasswordInput = v;
        break;
      }
    } else if (storePasswordInput.length < 6) {
      p.log.error('storePassword deve ter pelo menos 6 caracteres.');
      p.outro('Init cancelado.');
      return;
    }

    // keyPassword + confirmação (pula confirmação se reusar storePassword)
    if (!keyPasswordInput) {
      for (;;) {
        const v = await p.password({
          message: `Senha da chave (keyPassword) — Enter para usar a mesma do keystore:`,
          validate: (val) => {
            if (val && val.length > 0 && val.length < 6) return 'Senha deve ter pelo menos 6 caracteres';
            return undefined;
          },
        });
        if (isCancel(v)) { p.cancel('Operação cancelada.'); return; }
        // se vazio, usa storePassword (sem confirmação)
        if (!v || v.trim().length === 0) {
          keyPasswordInput = storePasswordInput;
          break;
        }
        const c = await p.password({
          message: 'Confirme a senha da chave:',
          validate: () => undefined,
        });
        if (isCancel(c)) { p.cancel('Operação cancelada.'); return; }
        if (v !== c) {
          p.log.error('Senhas não coincidem. Tente novamente.');
          continue;
        }
        keyPasswordInput = v;
        break;
      }
    }

    // dname
    if (!dnameInput) {
      const v = await p.text({
        message: 'DName (Distinguished Name) — Enter para padrão:',
        placeholder: defaultDname,
        initialValue: defaultDname,
      });
      if (isCancel(v)) { p.cancel('Operação cancelada.'); return; }
      dnameInput = v.trim() || defaultDname;
    }

    // validity
    if (!validityInput) {
      const v = await p.text({
        message: 'Validade em dias (validity):',
        placeholder: defaultValidity,
        initialValue: defaultValidity,
        validate: (val) => {
          const n = parseInt(val, 10);
          if (isNaN(n) || n <= 0) return 'Informe um número positivo';
          return undefined;
        },
      });
      if (isCancel(v)) { p.cancel('Operação cancelada.'); return; }
      validityInput = v.trim() || defaultValidity;
    }

    // nota fixa sobre keyAlg
    p.note('Algoritmo: RSA  |  Tamanho: 2048 bits  |  Validade: ' + validityInput + ' dias', 'Configuração da chave');
  } else {
    // --yes: usa env vars, existingProps ou defaults — reusa valores do keystore.properties existente se válido
    storeFileInput = storeFileInput || env.CAP_APK_STORE_FILE || existingProps.storeFile || defaultStoreFile;
    keyAliasInput = keyAliasInput || env.CAP_APK_KEY_ALIAS || existingProps.keyAlias || defaultAlias;
    const existingStorePassValid = existingProps.storePassword && existingProps.storePassword.length >= 6 ? existingProps.storePassword : undefined;
    const existingKeyPassValid = existingProps.keyPassword && existingProps.keyPassword.length >= 6 ? existingProps.keyPassword : undefined;
    storePasswordInput = storePasswordInput || env.CAP_APK_STORE_PASSWORD || existingStorePassValid;
    keyPasswordInput = keyPasswordInput || env.CAP_APK_KEY_PASSWORD || existingKeyPassValid || storePasswordInput;
    dnameInput = dnameInput || env.CAP_APK_DNAME || existingProps.dname || defaultDname;
    validityInput = validityInput || env.CAP_APK_VALIDITY || existingProps.validity || defaultValidity;

    // Validação de senha será feita após auto-correção para permitir reuso e correção de storeFile antes
    if (!keyPasswordInput) keyPasswordInput = storePasswordInput;
    p.log.info(`Modo --yes: storeFile=${storeFileInput}, keyAlias=${keyAliasInput}, validity=${validityInput}`);
    p.note('Algoritmo: RSA  |  Tamanho: 2048 bits', 'Configuração da chave');
  }

  let storeFileAbs = resolveKeystorePath(storeFileInput, projectRoot);
  let storeFileForProps = getStoreFileForProperties(storeFileAbs, projectRoot);
  // Auto-correção: se arquivo real existe com extensão diferente da solicitada, usa caminho real
  {
    const originalForProps = storeFileForProps;
    const originalAbs = storeFileAbs;
    let foundPath = findKeystoreFile(storeFileAbs);
    // Fallback para caso o input seja relativo a android/ (ex: ../my-keystore.jks) — resolve via android/
    if (!foundPath) {
      const trimmedInput = String(storeFileInput).trim();
      if (!path.isAbsolute(trimmedInput)) {
        const altViaAndroid = path.normalize(path.resolve(path.join(projectRoot, 'android'), trimmedInput));
        if (altViaAndroid !== storeFileAbs) {
          const altFound = findKeystoreFile(altViaAndroid);
          if (altFound) foundPath = altFound;
        }
      }
    }
    if (foundPath && path.normalize(foundPath) !== path.normalize(originalAbs)) {
      storeFileAbs = foundPath;
      storeFileForProps = getStoreFileForProperties(storeFileAbs, projectRoot);
      if (storeFileForProps !== originalForProps) {
        // Se original era absoluto (caso ../ resolvido via projectRoot para fora), mostra input original no log
        const isAbsOld = path.isAbsolute(originalForProps) || /^[a-zA-Z]:\//.test(originalForProps);
        const displayOld = isAbsOld ? String(storeFileInput).trim().replace(/\\/g, '/') : originalForProps;
        if (displayOld !== storeFileForProps) {
          p.log.warn(`▲ Corrigido storeFile: ${displayOld} -> ${storeFileForProps} (arquivo real sem/com extensão)`);
        }
      }
    }
  }
  // Validação em modo --yes após merge e auto-correção (permite reuso de senhas do arquivo existente e correção de storeFile)
  if (isYes) {
    if (!storePasswordInput || storePasswordInput.length < 6) {
      p.log.error('Em modo --yes é obrigatório informar --storePassword (ou env CAP_APK_STORE_PASSWORD) com mínimo 6 caracteres.');
      p.outro('Init cancelado.');
      return;
    }
    if (!keyPasswordInput || keyPasswordInput.length < 6) {
      if (storePasswordInput && storePasswordInput.length >= 6) keyPasswordInput = storePasswordInput;
      else {
        p.log.error('Em modo --yes é obrigatório informar --keyPassword válido (ou env CAP_APK_KEY_PASSWORD) ou deixar vazio para reusar storePassword.');
        p.outro('Init cancelado.');
        return;
      }
    }
  }
  const storePassword = storePasswordInput;
  const keyAlias = keyAliasInput;
  const keyPassword = keyPasswordInput;
  const dname = dnameInput;
  const validity = String(validityInput);

  p.log.info(`Keystore será criado em: ${storeFileAbs}`);
  p.log.info(`Keystore absoluto: ${storeFileAbs}`);
  p.log.info(`Valor em keystore.properties: ${storeFileForProps}`);

  // Se arquivo não existe, oferecer geração via keytool (em --yes gera automaticamente sem perguntar)
  if (!fs.existsSync(storeFileAbs)) {
    p.log.warn(`Keystore não encontrado em ${storeFileAbs}`);
    let shouldGen;
    if (isYes) {
      shouldGen = true;
      p.log.info('Modo --yes: gerando keystore automaticamente...');
    } else {
      shouldGen = await p.confirm({
        message: `Deseja gerar o keystore agora com keytool?`,
        initialValue: true,
      });
      if (isCancel(shouldGen)) { p.cancel('Operação cancelada.'); return; }
    }

    if (shouldGen) {
      const ksDir = path.dirname(storeFileAbs);
      fs.mkdirSync(ksDir, { recursive: true });

      const spinner = p.spinner();
      spinner.start('Gerando keystore com keytool...');

      const args = [
        '-genkeypair',
        '-v',
        '-keystore', storeFileAbs,
        '-alias', keyAlias,
        '-keyalg', 'RSA',
        '-keysize', '2048',
        '-validity', validity,
        '-storepass', storePassword,
        '-keypass', keyPassword,
        '-dname', dname,
      ];

      const res = spawnSync('keytool', args, { stdio: 'pipe', encoding: 'utf8' });

      if (res.error && res.error.code === 'ENOENT') {
        spinner.stop('keytool não encontrado');
        p.log.error('keytool não encontrado. Instale o JDK (ex: JDK 17) e garanta que "keytool" está no PATH.');
        p.log.info('No Windows: instale o Microsoft Build of OpenJDK ou Oracle JDK e adicione %JAVA_HOME%\\bin ao PATH.');
        p.log.info('No macOS: brew install openjdk@17');
        p.log.info('No Linux: sudo apt install openjdk-17-jdk');
        p.outro('Init incompleto — keystore não gerado.');
        return;
      }

      if (res.status !== 0) {
        spinner.stop('Falha ao gerar keystore');
        const out = (res.stdout || '') + (res.stderr || '');
        p.log.error(`keytool falhou (exit ${res.status}):\n${out}`);
        p.outro('Init incompleto.');
        return;
      }

      spinner.stop('Keystore gerado ✓');
      p.log.success(`Keystore criado em ${storeFileAbs}`);
    } else {
      p.log.warn('Keystore não gerado. Você precisará criá-lo manualmente antes de rodar cap-release-apk build.');
    }
  } else {
    p.log.success(`Keystore já existe: ${storeFileAbs}`);
  }

  // Criar android/keystore.properties
  const androidDir = path.join(projectRoot, 'android');
  fs.mkdirSync(androidDir, { recursive: true });
  const ksPropsPath = path.join(androidDir, 'keystore.properties');
  const ksPropsContent = `storeFile=${storeFileForProps}\nstorePassword=${storePassword}\nkeyAlias=${keyAlias}\nkeyPassword=${keyPassword}\n`;
  fs.writeFileSync(ksPropsPath, ksPropsContent, 'utf8');
  p.log.success(`Criado ${ksPropsPath}`);

  // Criar android/keystore.properties.example se não existir
  const examplePath = path.join(androidDir, 'keystore.properties.example');
  if (!fs.existsSync(examplePath)) {
    const exampleContent = `storeFile=release.jks\nstorePassword=***\nkeyAlias=release\nkeyPassword=***\n`;
    fs.writeFileSync(examplePath, exampleContent, 'utf8');
    p.log.success(`Criado ${examplePath} (exemplo sem senhas)`);
  } else {
    p.log.info(`${examplePath} já existe — mantido`);
  }

  // Patch android/app/build.gradle
  try {
    const gradlePath = path.join(androidDir, 'app', 'build.gradle');
    patchGradle(gradlePath);
    p.log.success('android/app/build.gradle patchado ✓');
  } catch (e) {
    p.log.error(`Falha ao patchar build.gradle: ${e.message}`);
    p.log.warn('Aplique manualmente o patch descrito no README.');
  }

  // Auto-detecção do Android SDK -> android/local.properties (idempotente, sem prompt; funciona em --yes e interativo)
  try {
    const detected = findAndroidSdk(projectRoot);
    if (detected && detected.source === 'local.properties') {
      p.log.info(`Android SDK já configurado em android/local.properties (${detected.path})`);
    } else if (detected) {
      const sdkForward = String(detected.path).replace(/\\/g, '/');
      const localPropsPath = path.join(androidDir, 'local.properties');
      fs.mkdirSync(androidDir, { recursive: true });
      // Preserva outras chaves existentes; troca apenas linhas sdk.dir= (arquivo válido já tratado acima)
      let keptLines = [];
      try {
        if (fs.existsSync(localPropsPath)) {
          const current = fs.readFileSync(localPropsPath, 'utf8');
          keptLines = String(current)
            .split(/\r?\n/)
            .filter((l) => !/^\s*sdk\.dir\s*=/.test(l));
          while (keptLines.length > 0 && !keptLines[keptLines.length - 1].trim()) keptLines.pop();
        }
      } catch {
        keptLines = [];
      }
      const newContent = [...keptLines, `sdk.dir=${sdkForward}`].join('\n') + '\n';
      fs.writeFileSync(localPropsPath, newContent, 'utf8');
      p.log.success(`Android SDK detectado via ${detected.source}: ${detected.path} -> android/local.properties ✓`);
    } else {
      p.log.warn('Android SDK não encontrado. Instale o Android Studio + SDK ou defina ANDROID_HOME ou crie android/local.properties com sdk.dir=<caminho-do-sdk>.');
    }
  } catch (e) {
    p.log.warn(`Não foi possível configurar android/local.properties: ${e?.message || e}`);
  }

  // Patch .gitignore em android/ e na raiz
  const requiredGitignoreLines = ['*.jks', '*.keystore', 'keystore.properties'];
  const requiredAndroidGitignoreLines = [...requiredGitignoreLines, 'local.properties'];
  try {
    ensureGitignore(androidDir, requiredAndroidGitignoreLines);
    p.log.success('android/.gitignore atualizado ✓');
  } catch (e) {
    p.log.warn(`Não foi possível atualizar android/.gitignore: ${e.message}`);
  }
  try {
    ensureGitignore(projectRoot, requiredGitignoreLines);
    p.log.success('.gitignore da raiz atualizado ✓');
  } catch (e) {
    p.log.warn(`Não foi possível atualizar .gitignore da raiz: ${e.message}`);
  }

  // Patch package.json host: scripts "apk" e "aab"
  try {
    const { pkg, pkgPath } = getPackageJson(projectRoot);
    if (pkg && pkgPath) {
      if (!pkg.scripts) pkg.scripts = {};
      let changed = false;
      if (!pkg.scripts.apk) {
        pkg.scripts.apk = 'cap-release-apk build';
        changed = true;
        p.log.success('Script "apk" adicionado ao package.json: "cap-release-apk build"');
      } else {
        p.log.info(`Script "apk" já existe em package.json: "${pkg.scripts.apk}" — mantido`);
      }
      if (!pkg.scripts.aab) {
        pkg.scripts.aab = 'cap-release-apk build --aab';
        changed = true;
        p.log.success('Script "aab" adicionado ao package.json: "cap-release-apk build --aab"');
      } else {
        p.log.info(`Script "aab" já existe em package.json: "${pkg.scripts.aab}" — mantido`);
      }
      if (changed) {
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      }
    } else {
      p.log.warn('package.json não encontrado — pulei adição dos scripts apk/aab');
    }
  } catch (e) {
    p.log.warn(`Não foi possível atualizar package.json: ${e.message}`);
  }

  p.note(
    `1. Confira android/keystore.properties\n2. Rode: npm run apk  ou  npm run aab  (ou  npx cap-release-apk build [--aab])\n3. APK em: android/app/build/outputs/apk/release/app-release.apk + cap-apk-outputs/\n4. AAB em: android/app/build/outputs/bundle/release/app-release.aab + cap-apk-outputs/`,
    'Próximos passos'
  );

  p.outro('CapReleaseAPK init concluído! 🎉');
}
