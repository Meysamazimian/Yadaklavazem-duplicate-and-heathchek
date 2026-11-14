// cPanel Application Startup File (same pattern as the Backend repo).
// 1. If compiled JavaScript exists (dist/index.js), run it directly.
// 2. Otherwise use ts-node on the fly to boot src/index.ts.
const fs = require('fs');
const path = require('path');

const distEntry = path.join(__dirname, 'dist', 'index.js');

if (fs.existsSync(distEntry)) {
  require(distEntry);
} else {
  require('ts-node').register({ transpileOnly: true });
  require('./src/index.ts');
}
