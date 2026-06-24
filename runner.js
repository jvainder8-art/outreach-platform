require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { run: runColdOutreach } = require('./lib/cold-outreach');
const { run: runNurtureSequence } = require('./lib/nurture-sequence');

const CLIENTS_DIR = path.join(__dirname, 'clients');

function log(msg) {
  console.log(`[${new Date().toLocaleString()}] [runner] ${msg}`);
}

async function main() {
  const clientNames = fs.readdirSync(CLIENTS_DIR).filter(name => {
    const configPath = path.join(CLIENTS_DIR, name, 'config.json');
    return fs.existsSync(configPath);
  });

  const target = process.argv[2];
  const clients = target ? clientNames.filter(n => n === target) : clientNames;

  if (clients.length === 0) {
    log(target ? `No client found: ${target}` : 'No clients configured.');
    process.exit(1);
  }

  log(`Running ${clients.length} client(s): ${clients.join(', ')}`);

  for (const clientName of clients) {
    const clientDir = path.join(CLIENTS_DIR, clientName);
    const config = JSON.parse(fs.readFileSync(path.join(clientDir, 'config.json')));

    // Shorthand: if auth.gmail and auth.sheets not split, assume same oauth for both
    if (config.auth && !config.auth.gmail && !config.auth.sheets) {
      config.auth = { gmail: config.auth, sheets: config.auth };
    }

    try {
      if (config.type === 'cold-outreach') {
        await runColdOutreach(config);
      } else if (config.type === 'nurture-sequence') {
        await runNurtureSequence(config, clientDir);
      } else {
        log(`Unknown type for ${clientName}: ${config.type}`);
      }
    } catch (err) {
      log(`Fatal error for ${clientName}: ${err.message}`);
    }
  }

  log('All clients complete.');
}

main();
