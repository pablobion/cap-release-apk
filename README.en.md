# CapReleaseAPK

[Português](./README.md) | [Español](./README.es.md)

CLI to generate a **signed APK** for Capacitor projects with a single command — interactive prompts + build.

```bash
npx cap-release-apk init   # configure keystore and patch Gradle (interactive)
npx cap-release-apk build  # npm run build + cap sync + gradlew assembleRelease
```

Works with any Capacitor project that has `android/` on Windows, macOS and Linux.

## What it does

Automates the manual signing flow:

1. Creates the keystore (`*.jks`) via `keytool` (RSA 2048)
2. Creates `android/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`)
3. Creates `android/keystore.properties.example` (without passwords, safe to commit)
4. Applies an idempotent patch to `android/app/build.gradle` for `signingConfigs.release`
5. Updates `.gitignore` (root and `android/`) with `*.jks`, `*.keystore`, `keystore.properties`
6. Adds `scripts.apk = "cap-release-apk build"` to the host `package.json`
7. On `build`, runs `npm run build` (if present) → `npx cap sync android` → `gradlew assembleRelease` → copies APK to `dist-apk/` and `android/app/build/outputs/apk/release/`

On first run it asks interactive questions (`@clack/prompts`); afterwards a single command rebuilds the APK.

## Requirements

- **Node** ≥ 18
- Capacitor project with `android/` created (`npx cap add android`) and `capacitor.config.*`
- **JDK 17+** (AGP 8+) with `java` and `keytool` on `PATH`
- **Android SDK** with `ANDROID_HOME`/`ANDROID_SDK_ROOT` or `sdk.dir` in `android/local.properties`
- **Gradle Wrapper** (`android/gradlew` or `android/gradlew.bat` on Windows)

## Installation

```bash
npm i -D cap-release-apk
```

Exposes three equivalent binaries: `apk`, `cap-apk` (compatibility) and `cap-release-apk`.

## Usage

### 1. Initialize — `npx cap-release-apk init`

```bash
npx cap-release-apk init
# aliases
npx apk init
npx cap-apk init
```

Prompts (skipped if already passed via CLI):

| Field | Default | Notes |
|---|---|---|
| `storeFile` | `android/app/release.jks` | keystore path |
| `keyAlias` | `release` | key alias |
| `storePassword` | *(required, ≥6 chars)* | `password` input |
| `keyPassword` | `= storePassword` | Enter to reuse |
| `dname` | `CN=CapReleaseAPK, OU=Mobile, O=App, C=BR` | Distinguished Name |
| `validity` | `10000` days | ~27 years |
| `keyAlg` / `keysize` | `RSA` / `2048` | fixed, shown as `note` |

If the file does not exist, it asks whether to generate it via:

```bash
keytool -genkeypair -v -keystore <storeFile> -alias <alias> -keyalg RSA -keysize 2048 -validity <days> -storepass <pass> -keypass <pass> -dname "<dname>"
```

`init` behavior:

- If `storeFile` is inside `android/app/`, only the filename is written to `keystore.properties`; otherwise a path relative to `android/` (e.g. `../my-keystore.jks`) or an absolute path (if outside the project) is written. The `build.gradle` resolves it via `rootProject.file()` with a `file()` fallback for bare filenames.
- Idempotent patch to `android/app/build.gradle`: injects `keystore.properties` loader before `android {`, `signingConfigs.release` block and `signingConfig signingConfigs.release` in `buildTypes.release`.
- Updates `.gitignore` (uncomments if present as `# *.jks`).
- Does not overwrite `scripts.apk` if it already exists.

#### Non-interactive mode (`--yes` / CI)

```bash
npx cap-release-apk init --yes \
  --storeFile android/app/release.jks \
  --keyAlias release \
  --storePassword "$CAP_APK_STORE_PASSWORD" \
  --keyPassword "$CAP_APK_KEY_PASSWORD"
```

With `--yes` it also reads environment variables:

`CAP_APK_STORE_FILE`, `CAP_APK_STORE_PASSWORD`, `CAP_APK_KEY_ALIAS`, `CAP_APK_KEY_PASSWORD`, `CAP_APK_DNAME`, `CAP_APK_VALIDITY`

If `keystore.properties` already exists, `--yes` reuses valid values as defaults.

### 2. Build APK — `npx cap-release-apk build`

```bash
npx cap-release-apk build          # release → assembleRelease (requires keystore.properties)
npx cap-release-apk build --debug  # debug → assembleDebug (no keystore required)
npx cap-release-apk build --verbose # full Gradle output

# via script added by init
npm run apk
npm run apk -- --debug
```

Steps:

1. Checks (`java`, `keystore.properties`, `gradlew`, `build.gradle`)
2. `npm run build` (if `scripts.build` exists)
3. `npx cap sync android` (fallback `npx cap sync`)
4. `gradlew assembleRelease` (`gradlew.bat` on Windows) with 300s timeout
5. Locates `android/app/build/outputs/apk/release/app-release.apk` (or `debug/app-debug.apk`), prints size and copies to `dist-apk/`

### 3. Diagnostics — `npx cap-release-apk doctor`

```bash
npx cap-release-apk doctor
```

Checks and reports (exit `0` ok, `1` on issues):

- Node ≥ 18
- `java -version` (JDK 17+ recommended)
- `keytool` available
- `ANDROID_HOME` / `ANDROID_SDK_ROOT` or `sdk.dir` in `android/local.properties`
- `android/` and `gradlew`/`gradlew.bat`
- `capacitor.config.*`
- `keystore.properties` exists and points to a valid keystore (tolerates `.jks`/`.keystore`)
- `build.gradle` contains `signingConfigs` + `keystoreProperties`

## CI

Keep `*.jks` out of Git. Use Secrets and restore in CI:

```yaml
- uses: actions/setup-java@v4
  with:
    distribution: temurin
    java-version: '17'
- uses: android-actions/setup-android@v3

- name: Setup keystore
  env:
    CAP_APK_STORE_PASSWORD: ${{ secrets.CAP_APK_STORE_PASSWORD }}
    CAP_APK_KEY_PASSWORD: ${{ secrets.CAP_APK_KEY_PASSWORD }}
  run: |
    echo "$KEYSTORE_BASE64" | base64 -d > android/app/release.jks
    npx cap-release-apk init --yes --storeFile android/app/release.jks --keyAlias release --storePassword "$CAP_APK_STORE_PASSWORD" --keyPassword "$CAP_APK_KEY_PASSWORD"

- run: npx cap-release-apk build
```

> Do not generate a new keystore in CI for releases — use a stable one stored as a base64 secret.

## Security

- `android/keystore.properties` contains passwords in plain text — **never commit it**. `init` already adds `keystore.properties`, `*.jks` and `*.keystore` to `.gitignore`.
- Only commit `android/keystore.properties.example` (passwords as `***`).
- In CI, inject passwords via `CAP_APK_STORE_PASSWORD` / `CAP_APK_KEY_PASSWORD` (Secrets).
- Back up the `.jks` securely — losing it prevents updating the app on the Play Store with the same signature.
- The Gradle patch reads passwords only if `keystore.properties` exists; otherwise `signingConfig` remains empty.

## Limitations

- Produces only **APK** (`assembleRelease` / `assembleDebug`). No AAB support.
- Supports only **Groovy DSL** (`android/app/build.gradle`). No Kotlin DSL (`build.gradle.kts`) support.
- `RSA 2048` is fixed for `keytool`; `validity` and `dname` are configurable.
- Requires an existing `android/` (`npx cap add android`).

## License

MIT — see [LICENSE](./LICENSE).
