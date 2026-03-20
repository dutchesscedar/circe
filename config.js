// Stores user-configured credentials in config.json (gitignored).
// config.json values take priority over .env, so the settings UI works
// without needing to edit any files manually.

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');

function load() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(e) { return {}; }
}

function save(data) {
  const current = load();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...current, ...data }, null, 2));
}

// Get a value — config.json first, then .env
function get(key) {
  return load()[key] || process.env[key] || '';
}

module.exports = { load, save, get };
