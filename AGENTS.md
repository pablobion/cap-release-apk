# AGENTS.md — cap-release-apk

Guia para agentes de IA e contribuidores que alteram este repositório.

## Finalidade

`cap-release-apk` (CapReleaseAPK) é um **CLI devDependency** para projetos Capacitor (Android) que automatiza a geração de **APK e AAB assinados**:

- `npx cap-release-apk init` — coleta dados de assinatura (prompts interativos), gera keystore via `keytool`, cria `android/keystore.properties` + `.example`, aplica patch idempotente em `android/app/build.gradle`, atualiza `.gitignore` e injeta `scripts.apk` (`cap-release-apk build`) e `scripts.aab` (`cap-release-apk build --aab`) no `package.json` host.
- `npx cap-release-apk build [--aab|--bundle] [--debug] [--verbose]` — valida ambiente, roda `npm run build` (se existir) → `npx cap sync android` → `gradlew assembleRelease` (APK → `cap-apk-outputs/`) ou `gradlew bundleRelease` com `--aab`/`--bundle` (AAB → `cap-apk-outputs/`) (`gradlew.bat` no Windows).
- `npx cap-release-apk doctor` — verifica Node, Java/keytool, Android SDK, `android/`/`gradlew`, `capacitor.config.*`, `keystore.properties` e `signingConfigs`.

Fluxo de entrada: `bin/apk.js` (commander) dispatcha para `src/init.js`, `src/build.js`, `src/doctor.js`. Helpers em `src/utils.js` e patch em `src/patch-gradle.js`.

## Stack

- **Node** ≥ 18, **ESM** (`"type": "module"`), sem transpiler.
- Dependências: `commander` (CLI) e `@clack/prompts` (prompts/spinner/log). Ver `package.json`.
- Sem framework de testes configurado — `npm test` roda `node --test` (nativo).
- Binários expostos: `apk`, `cap-apk` (compatibilidade) e `cap-release-apk` → `./bin/apk.js` (shebang `#!/usr/bin/env node`).
- Armazenado em `files: ["bin/", "src/", "template/"]` para `npm pack`.

## Estrutura

```
bin/apk.js               # entry point — define comandos commander
src/init.js              # lógica do `init` (prompts, keytool, keystore.properties, patch)
src/build.js             # lógica do `build` (checks, npm build, cap sync, gradle)
src/doctor.js            # lógica do `doctor` (checagens reportadas)
src/utils.js             # findProjectRoot, ensureGitignore, findKeystoreFile, resolveKeystorePath, getStoreFileForProperties, etc.
src/patch-gradle.js      # patch idempotente em android/app/build.gradle (Groovy DSL)
template/keystore.properties.example  # template commitável (senhas ***)
```

`findProjectRoot` sobe diretórios procurando `capacitor.config.{ts,js,json}`, `android/` ou `package.json`.

## Comandos de desenvolvimento / teste

```bash
npm install          # instala deps
npm test             # node --test (sem suite dedicada hoje)
node --test          # equivalente
npx cap-release-apk doctor       # valida ambiente em um projeto host
npx cap-release-apk init --help
npx cap-release-apk build --help
```

Exemplos são portáveis (`npm`, `npx`). Diferença principal Windows/Linux/macOS: `gradlew.bat` vs `gradlew` e `shell: true` para `spawnSync` no Windows (ver `src/build.js` e `src/init.js`). Não assumir `bash` em Windows.

## Fluxo da CLI

### `init` (`src/init.js`)
1. Detecta `projectRoot` via `findProjectRoot`.
2. Carrega `android/keystore.properties` existente (se houver) para defaults e aviso de divergência `storeFile`.
3. Coleta `storeFile`, `keyAlias`, `storePassword`, `keyPassword`, `dname`, `validity` com prioridade `opts CLI > env (se --yes) > prompts`. Defaults: `android/app/release.jks`, `release`, `CN=CapReleaseAPK, OU=Mobile, O=App, C=BR`, `10000`, RSA 2048 fixo.
4. `resolveKeystorePath` + `getStoreFileForProperties` + auto-correção `findKeystoreFile` (tolera `.jks`/`.keystore` e bare filename).
5. Se arquivo não existe: `spawnSync('keytool', ['-genkeypair', ...])` — trata `ENOENT` com instruções JDK por OS.
6. Escreve `android/keystore.properties` e `android/keystore.properties.example` (se não existir).
7. `patchGradle(android/app/build.gradle)` — injeção antes de `android {`, `signingConfigs` e `signingConfig signingConfigs.release`.
8. `ensureGitignore` em `android/` e raiz (descomenta `# *.jks` se necessário).
9. Injeta `scripts.apk = "cap-release-apk build"` e `scripts.aab = "cap-release-apk build --aab"` no `package.json` host se ausentes.

### `build` (`src/build.js`)
1. Checks rápidos (`android/`, `gradlew`, `keystore.properties` em release, `build.gradle`, `java -version`).
2. Auto-corrige `storeFile` em `keystore.properties` se arquivo real diverge (via `findKeystoreFile`).
3. `npm run build` se `scripts.build` existir; senão avisa e pula.
4. `npx cap sync android` (fallback `npx cap sync`) com `shell` no Windows.
5. `gradlew assembleRelease` (ou `assembleDebug` com `--debug`) ou `gradlew bundleRelease` (ou `bundleDebug` com `--debug`) com `--aab`/`--bundle`, com `timeout 300_000`, `maxBuffer 10MB`; `--verbose` adiciona `--info` e mostra mais saída.
6. Localiza APK em `android/app/build/outputs/apk/{release,debug}/` e copia para `cap-apk-outputs/`, ou AAB em `android/app/build/outputs/bundle/{release,debug}/` e copia para `cap-apk-outputs/`.

### `doctor` (`src/doctor.js`)
Checa Node ≥18, `java -version` (major ≥17), `keytool -help`, `ANDROID_HOME`/`ANDROID_SDK_ROOT` ou `sdk.dir` em `android/local.properties`, `android/`, `gradlew`, `capacitor.config.*`, `keystore.properties` (campos + existência do keystore com fallback), `build.gradle` (`signingConfigs` + `keystoreProperties`). Retorna `0`/`1`.

## Cuidados de segurança com keystore

- **Nunca commitar** `*.jks`, `*.keystore` ou `android/keystore.properties` — contêm senhas em texto puro. `init` garante `.gitignore` com `*.jks`, `*.keystore`, `keystore.properties`.
- Versionar apenas `android/keystore.properties.example` (valores `***`).
- Em CI, usar variáveis `CAP_APK_STORE_PASSWORD` / `CAP_APK_KEY_PASSWORD` via Secrets; restaurar `.jks` via `base64 -d` (portável: `echo` + `base64 -d`). Não gerar keystore novo em CI para releases.
- `storeFile` em `keystore.properties` é relativo a `android/` quando dentro do projeto; absoluto se fora. Validar com `findKeystoreFile` antes de assumir existência.
- Senhas com mínimo 6 caracteres; `keyPassword` default = `storePassword` se vazio.
- Backup seguro do `.jks` é obrigatório — perda impede updates com mesma assinatura.

## Limitações (não inventar suporte)

- Gera **APK** (`assembleRelease`/`assembleDebug`) e **AAB** (`bundleRelease`/`bundleDebug` com `--aab`/`--bundle` → `cap-apk-outputs/`).
- Apenas **Groovy DSL** (`android/app/build.gradle`). Sem Kotlin DSL (`build.gradle.kts`).
- `keyAlg` RSA e `keysize` 2048 são fixos; apenas `dname` e `validity` são parametrizáveis.
- Requer `android/` preexistente e `capacitor.config.*`.
- `keytool`/`java` devem estar no `PATH` com JDK 17+.
- Timeout Gradle 300s e buffer 10MB são limites atuais.

## Regras de alteração / verificação

- **Escopo**: altere apenas arquivos necessários. Para docs, limite-se a `README.md`, `README.en.md`, `README.es.md`, `AGENTS.md`. **Não altere** `package.json`, `bin/`, `src/` ou outros fora do escopo sem solicitação explícita.
- **Não inventar**: não adicione funcionalidades, testes, AAB ou Kotlin DSL fictícios. Use somente fatos confirmados em `package.json`, `bin/apk.js`, `src/*.js` e `template/`.
- **Idempotência**: preserve comportamento idempotente do patch Gradle e `.gitignore` (não duplicar entradas).
- **Portabilidade**: mantenha exemplos shell portáveis (`npx`, `npm`). Mencione `gradlew.bat` vs `gradlew` / `shell: true` no Windows apenas quando relevante.
- **Links**: todos os links relativos no topo dos READMEs devem apontar para arquivos existentes — validar antes de commitar:
  - `README.md` → `./README.en.md`, `./README.es.md`, `./LICENSE`
  - `README.en.md` → `./README.md`, `./README.es.md`, `./LICENSE`
  - `README.es.md` → `./README.md`, `./README.en.md`, `./LICENSE`
- **Verificação mínima** após editar docs:
  ```bash
  node -e "const fs=require('fs'); ['./README.md','./README.en.md','./README.es.md','./AGENTS.md','./LICENSE'].forEach(f=>{if(!fs.existsSync(f))throw new Error('missing '+f)}); console.log('links ok')"
  # opcional: checar conteúdo dos links
  grep -n "README" README.md README.en.md README.es.md
  ```
- **Estilo**: conciso, claro, consistente entre as três línguas. Não adicione estilo visual além de markdown simples.

