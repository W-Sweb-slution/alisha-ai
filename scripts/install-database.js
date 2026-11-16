'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

// Run only with the application stopped or in Render maintenance mode.
async function installDatabase(sourcePath, destinationPath) {
  if (!sourcePath || !destinationPath) throw new Error('Provide source and destination SQLite paths.');
  const source = path.resolve(sourcePath), destination = path.resolve(destinationPath);
  if (source === destination || fs.existsSync(destination)) throw new Error('Destination already exists. Refusing to overwrite any database.');
  const contents = fs.readFileSync(source);
  const SQL = await initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) });
  const db = new SQL.Database(contents);
  try {
    const result = db.exec('PRAGMA integrity_check');
    if (result[0]?.values?.length !== 1 || result[0].values[0][0] !== 'ok') throw new Error('Source database integrity check failed.');
    const names = new Set(db.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0]?.values.map(([name]) => name));
    if (!names.has('users') || !names.has('sessions')) throw new Error('Source is not an ALISHA authentication database.');
    if (db.exec('PRAGMA foreign_key_check').length) throw new Error('Source database has invalid ownership relationships.');
  } finally { db.close(); }
  const temporary = path.join(path.dirname(destination), `.alisha-import-${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    // An atomic hard link fails if the destination exists, even if it appeared
    // after validation. Both paths are on the same mounted filesystem.
    if (process.platform === 'win32') {
      // Windows sandboxes can forbid hard links. Exclusive copy still refuses
      // any existing destination; the app must remain stopped during import.
      fs.copyFileSync(temporary, destination, fs.constants.COPYFILE_EXCL);
      const installed = fs.openSync(destination, 'r+');
      try { fs.fsyncSync(installed); } finally { fs.closeSync(installed); }
    } else fs.linkSync(temporary, destination);
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(destination), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
if (require.main === module) installDatabase(...process.argv.slice(2)).then(() => {
  console.log('Database installed and verified. Source preserved. Existing destination databases are never overwritten.');
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { installDatabase };
