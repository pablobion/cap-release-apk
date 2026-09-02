import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot } from './utils.js';

const KEYSTORE_LOADER = `def keystoreProperties = new Properties()
def keystorePropertiesFile = rootProject.file('keystore.properties')
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}
`;

const SIGNING_CONFIG_BLOCK = `    signingConfigs {
        release {
            if (keystorePropertiesFile.exists()) {
                def _capStoreFile = keystoreProperties['storeFile'] ?: 'release.jks'
                // Resolve relative to android dir (rootProject) so that "app/release.jks" and "../my-keystore.jks" work,
                // and absolute paths remain absolute. Fallback to file() for legacy bare filenames.
                def _capFile = rootProject.file(_capStoreFile)
                if (!_capFile.exists()) {
                    def _alt = file(_capStoreFile)
                    if (_alt.exists()) _capFile = _alt
                }
                storeFile _capFile
                storePassword keystoreProperties['storePassword']
                keyAlias keystoreProperties['keyAlias']
                keyPassword keystoreProperties['keyPassword']
            }
        }
    }
`;

export function patchGradle(gradlePath) {
  let resolved = gradlePath;

  if (!resolved) {
    const root = findProjectRoot(process.cwd());
    if (!root) throw new Error('Não foi possível localizar a raiz do projeto. Execute dentro de um projeto Capacitor.');
    resolved = path.join(root, 'android', 'app', 'build.gradle');
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`Arquivo não encontrado: ${resolved}. Verifique se o projeto tem android/app/build.gradle (rode "npx cap add android").`);
  }

  let content = fs.readFileSync(resolved, 'utf8');

  // Idempotência: se já contém os dois marcadores, não faz nada
  if (content.includes('keystoreProperties') && content.includes('signingConfigs')) {
    // verifica mais especificamente se já tem loader e signingConfigs release
    if (content.includes("keystorePropertiesFile") && content.includes("storeFile file(keystoreProperties['storeFile']")) {
      console.log('[cap-release-apk] build.gradle já patchado — nada a fazer.');
      return { patched: false, reason: 'already-patched', path: resolved };
    }
  }

  // 1) Injetar loader de keystoreProperties antes de "android {"
  if (!content.includes('keystorePropertiesFile')) {
    const androidIdx = content.indexOf('android {');
    if (androidIdx === -1) {
      // tenta variação com quebra de linha: android{
      const match = content.match(/android\s*\{/);
      if (!match || match.index === undefined) {
        throw new Error('Não foi possível encontrar o bloco "android {" em android/app/build.gradle. Verifique o arquivo.');
      }
      const idx = match.index;
      content = content.slice(0, idx) + KEYSTORE_LOADER + '\n' + content.slice(idx);
    } else {
      content = content.slice(0, androidIdx) + KEYSTORE_LOADER + '\n' + content.slice(androidIdx);
    }
  }

  // 2) Injetar signingConfigs dentro de android { ... }
  if (!content.includes('signingConfigs')) {
    // encontra primeira ocorrência de "android {" e insere logo após a linha
    const androidMatch = content.match(/android\s*\{/);
    if (!androidMatch || androidMatch.index === undefined) {
      throw new Error('Bloco android { não encontrado para injetar signingConfigs.');
    }
    const insertPos = androidMatch.index + androidMatch[0].length;
    // insere após a quebra de linha seguinte se houver
    // procura fim da linha do android {
    const nextNewline = content.indexOf('\n', insertPos);
    const pos = nextNewline !== -1 ? nextNewline + 1 : insertPos;
    content = content.slice(0, pos) + '\n' + SIGNING_CONFIG_BLOCK + content.slice(pos);
  }

  // 3) Garantir que buildTypes.release tenha signingConfig signingConfigs.release
  // Estratégia: procurar buildTypes { ... release { ... } } e injetar se não houver
  if (!content.includes('signingConfig signingConfigs.release')) {
    // regex para achar buildTypes
    const buildTypesMatch = content.match(/buildTypes\s*\{/);
    if (buildTypesMatch && buildTypesMatch.index !== undefined) {
      // a partir de buildTypes, procurar release {
      const fromBuildTypes = content.slice(buildTypesMatch.index);
      const releaseMatch = fromBuildTypes.match(/release\s*\{/);
      if (releaseMatch && releaseMatch.index !== undefined) {
        const absoluteReleaseIdx = buildTypesMatch.index + releaseMatch.index + releaseMatch[0].length;
        // verifica se dentro do bloco release já existe signingConfig
        const afterRelease = content.slice(absoluteReleaseIdx, absoluteReleaseIdx + 2000);
        if (!afterRelease.includes('signingConfig signingConfigs.release')) {
          // insere logo após "release {"
          const nextNl = content.indexOf('\n', absoluteReleaseIdx);
          const insertAt = nextNl !== -1 ? nextNl + 1 : absoluteReleaseIdx;
          const indent = '            ';
          content = content.slice(0, insertAt) + `${indent}signingConfig signingConfigs.release\n` + content.slice(insertAt);
        }
      } else {
        // buildTypes existe mas sem bloco release — adiciona um bloco release mínimo antes do fechamento de buildTypes
        // isso é incomum em projetos Capacitor; apenas loga aviso
        console.warn('[cap-release-apk] Aviso: buildTypes encontrado mas bloco release não localizado. Adicione manualmente: signingConfig signingConfigs.release');
      }
    } else {
      console.warn('[cap-release-apk] Aviso: bloco buildTypes não encontrado. Verifique android/app/build.gradle e adicione signingConfig manualmente se necessário.');
    }
  }

  fs.writeFileSync(resolved, content, 'utf8');
  console.log(`[cap-release-apk] Patch aplicado em ${resolved}`);
  return { patched: true, path: resolved };
}
