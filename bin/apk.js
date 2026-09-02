#!/usr/bin/env node
import { Command } from 'commander';
import { init } from '../src/init.js';
import { build } from '../src/build.js';
import { doctor } from '../src/doctor.js';

const program = new Command();

program
  .name('cap-release-apk')
  .description('CapReleaseAPK — CLI para gerar APK assinado em projetos Capacitor')
  .version('0.1.0');

program
  .command('init')
  .description('Configura keystore e patch do projeto (interativo)')
  .option('--yes', 'usa env vars e defaults sem perguntas')
  .option('--storeFile <path>', 'caminho do keystore (ex: android/app/release.jks)')
  .option('--storePassword <pass>', 'senha do keystore')
  .option('--keyAlias <alias>', 'alias da chave')
  .option('--keyPassword <pass>', 'senha da chave')
  .option('--dname <dname>', 'Distinguished Name (ex: "CN=CapReleaseAPK, OU=Mobile, O=App, C=BR")')
  .option('--validity <days>', 'validade em dias')
  .action(async (opts) => {
    try {
      await init(opts);
    } catch (e) {
      console.error('[cap-release-apk] erro no init:', e?.message || e);
      process.exitCode = 1;
    }
  });

program
  .command('build')
  .description('Gera APK assinado (release) ou debug')
  .option('--debug', 'gera APK debug (assembleDebug); não exige keystore')
  .option('--verbose', 'mostra saída completa do Gradle (útil para debug)')
  .action(async (opts) => {
    try {
      await build(opts);
    } catch (e) {
      console.error('[cap-release-apk] erro no build:', e?.message || e);
      process.exitCode = 1;
    }
  });

program
  .command('doctor')
  .description('Verifica requisitos e configuração do projeto')
  .action(async () => {
    try {
      const code = await doctor();
      process.exitCode = code;
    } catch (e) {
      console.error('[cap-release-apk] erro no doctor:', e?.message || e);
      process.exitCode = 1;
    }
  });

// se nenhum comando, mostra help
if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

program.parse(process.argv);
