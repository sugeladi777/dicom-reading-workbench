const { spawn } = require('node:child_process');
const path = require('node:path');

const electronBinary = require('electron');
const projectRoot = path.resolve(__dirname, '..');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

if (process.argv.includes('--dev')) {
  env.WORKBENCH_DEV = '1';
}

const child = spawn(electronBinary, ['.'], {
  cwd: projectRoot,
  env,
  stdio: 'inherit'
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

