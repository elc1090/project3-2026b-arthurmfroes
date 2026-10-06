import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDirectory = process.argv[2] ? resolve(process.argv[2]) : null;

if (!outputDirectory) {
  console.error('Uso: npm run experiment:sync -- <diretório-de-saída>');
  process.exitCode = 2;
} else {
  const result = spawnSync(process.execPath, ['--test', 'test/sync-experiment.browser.test.js'], {
    cwd: projectRoot,
    env: { ...process.env, SYNC_EXPERIMENT_OUTPUT_DIR: outputDirectory },
    stdio: 'inherit',
    timeout: 90_000,
  });
  if (result.error) {
    console.error(`Runner falhou: ${result.error.message}`);
    process.exitCode = 1;
  } else if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  } else {
    console.log(`Comparação exportada para ${outputDirectory}/sync-experiment.json e sync-experiment.csv`);
    console.log('Os bytes representam payloads de aplicação; o relatório não estima overhead físico da rede.');
  }
}
