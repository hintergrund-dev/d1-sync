#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const args = parseArgs({
  options: {
    schema: { type: 'string', short: 's', default: './db/schema.sql' },
    db: { type: 'string', short: 'd' },
    'dry-run': { type: 'boolean' },
    'local-only': { type: 'boolean' },
    'remote-only': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }
  },
  allowPositionals: true
});

if (args.values.help) {
  console.log(`
Usage: d1-sync [options]

Options:
  -s, --schema <path>      Path to your schema.sql file (default: ./db/schema.sql)
  -d, --db <name>          Database name (default: parses from wrangler.toml/jsonc)
      --dry-run            Print the generated SQL without applying it
      --local-only         Only apply the migration to the local D1 database
      --remote-only        Only apply the migration to the remote D1 database
  -h, --help               Show this help message
  `);
  process.exit(0);
}

const cwd = process.cwd();

// Helper to find wrangler config
function getWranglerConfig() {
  const paths = [
    path.join(cwd, 'wrangler.jsonc'),
    path.join(cwd, 'wrangler.toml'),
    path.join(cwd, 'wrangler.json')
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf8');
      const match = content.match(/"database_name"\s*:\s*"([^"]+)"/) || 
                    content.match(/database_name\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    }
  }
  return null;
}

const DB_NAME = args.values.db || getWranglerConfig();
if (!DB_NAME) {
  console.error('Error: Could not determine database name. Please provide --db or ensure wrangler config has d1_databases configured.');
  process.exit(1);
}

const SCHEMA_FILE = path.resolve(cwd, args.values.schema);

async function main() {
  if (!existsSync(SCHEMA_FILE)) {
    console.error(`Error: Schema file not found at ${SCHEMA_FILE}`);
    process.exit(1);
  }

  console.log(`Fetching remote schema for "${DB_NAME}"...`);
  const remoteResult = spawnSync('npx', ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--command', "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL", '--json'], { encoding: 'utf8', cwd, maxBuffer: 10 * 1024 * 1024 });
  
  if (remoteResult.status !== 0) {
    console.error('Failed to fetch remote schema:', remoteResult.stderr || remoteResult.stdout);
    process.exit(1);
  }

  let remoteRows = [];
  try {
    const parsed = JSON.parse(remoteResult.stdout);
    if (parsed && parsed[0] && parsed[0].results) {
      remoteRows = parsed[0].results;
    } else {
      throw new Error("Unexpected JSON structure from wrangler");
    }
  } catch (err) {
    console.error('Failed to parse remote schema from D1. Output might be truncated or invalid due to D1 limits.', err.message);
    console.error('Raw stdout snippet:', remoteResult.stdout ? remoteResult.stdout.substring(0, 500) : 'No stdout');
    process.exit(1);
  }
  const remoteTables = {};

  const tempRemoteDb = path.join(cwd, '.d1_sync_remote_temp.db');
  if (existsSync(tempRemoteDb)) unlinkSync(tempRemoteDb);
  
  for (const row of remoteRows) {
    spawnSync('sqlite3', [tempRemoteDb, row.sql]);
  }

  const tablesList = spawnSync('sqlite3', [tempRemoteDb, ".tables"], { encoding: 'utf8' }).stdout.trim().split(/\s+/);
  for (const table of tablesList) {
    if (!table) continue;
    const info = spawnSync('sqlite3', [tempRemoteDb, `PRAGMA table_info(${table})`], { encoding: 'utf8' }).stdout.trim().split('\n');
    remoteTables[table] = info.map(line => {
      const parts = line.split('|');
      return { name: parts[1], type: parts[2], notnull: parts[3] === '1', dflt_value: parts[4], pk: parts[5] === '1' };
    });
  }
  unlinkSync(tempRemoteDb);

  console.log(`Loading local schema from ${SCHEMA_FILE}...`);
  const tempLocalDb = path.join(cwd, '.d1_sync_local_temp.db');

  if (existsSync(tempLocalDb)) unlinkSync(tempLocalDb);
  
  const loadResult = spawnSync('sqlite3', [tempLocalDb, `.read ${SCHEMA_FILE}`], { encoding: 'utf8' });
  if (loadResult.status !== 0) {
    console.error('Failed to load local schema:', loadResult.stderr);
    process.exit(1);
  }

  const localTablesList = spawnSync('sqlite3', [tempLocalDb, ".tables"], { encoding: 'utf8' }).stdout.trim().split(/\s+/);
  const localTables = {};
  for (const table of localTablesList) {
    if (!table) continue;
    const info = spawnSync('sqlite3', [tempLocalDb, `PRAGMA table_info(${table})`], { encoding: 'utf8' }).stdout.trim().split('\n');
    localTables[table] = info.map(line => {
      const parts = line.split('|');
      return { name: parts[1], type: parts[2], notnull: parts[3] === '1', dflt_value: parts[4], pk: parts[5] === '1' };
    });
  }
  
  const localIndexesOutput = spawnSync('sqlite3', [tempLocalDb, "SELECT name || '|' || sql FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL"], { encoding: 'utf8' }).stdout.trim();
  const localIndexes = localIndexesOutput ? localIndexesOutput.split('\n').map(line => {
    const idx = line.indexOf('|');
    return { name: line.slice(0, idx), sql: line.slice(idx + 1) };
  }) : [];
  const remoteIndexes = remoteRows.filter(r => r.type === 'index');

  let migrationSql = '';
  let needsForeignKeysOff = false;

  function getCreateTableSql(dbPath, tableName, ifNotExists = true) {
    const sql = spawnSync('sqlite3', [dbPath, `SELECT sql FROM sqlite_master WHERE name='${tableName}' AND type='table'`], { encoding: 'utf8' }).stdout.trim();
    if (!sql) return '';
    let cleanSql = ifNotExists
      ? sql.replace(/^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?/i, 'CREATE TABLE IF NOT EXISTS ')
      : sql.replace(/^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?/i, 'CREATE TABLE ');
    if (!cleanSql.endsWith(';')) cleanSql += ';';
    return cleanSql;
  }

  function columnsEqual(a, b) {
    return a.name === b.name &&
      (a.type || '').toLowerCase() === (b.type || '').toLowerCase() &&
      a.notnull === b.notnull &&
      String(a.dflt_value ?? '').toLowerCase() === String(b.dflt_value ?? '').toLowerCase() &&
      a.pk === b.pk;
  }

  function quoteIdent(name) {
    return `"${String(name).replaceAll('"', '""')}"`;
  }
  
  for (const [tableName, columns] of Object.entries(localTables)) {
    if (!remoteTables[tableName]) {
      console.log(`Table ${tableName} is new.`);
      const sql = getCreateTableSql(tempLocalDb, tableName, true);
      if (sql) migrationSql += `${sql}\n`;
    } else {
      const remoteCols = remoteTables[tableName];
      const remoteColsByName = new Map(remoteCols.map(c => [c.name, c]));
      const localColsByName = new Map(columns.map(c => [c.name, c]));
      const removedCols = remoteCols.filter(c => !localColsByName.has(c.name));
      const changedCols = columns.filter(c => remoteColsByName.has(c.name) && !columnsEqual(c, remoteColsByName.get(c.name)));

      if (removedCols.length || changedCols.length) {
        needsForeignKeysOff = true;
        console.log(`Table ${tableName} changed incompatibly. Recreating...`);
        const createSql = getCreateTableSql(tempLocalDb, tableName, false).replace(new RegExp(`CREATE TABLE\\s+${tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'), `CREATE TABLE ${quoteIdent(`${tableName}__d1_sync_new`)}`);
        const commonCols = columns.filter(c => remoteColsByName.has(c.name) && !changedCols.some(changed => changed.name === c.name)).map(c => c.name);
        migrationSql += `DROP TABLE IF EXISTS ${quoteIdent(`${tableName}__d1_sync_new`)};\n`;
        migrationSql += `${createSql}\n`;
        if (commonCols.length) {
          const cols = commonCols.map(quoteIdent).join(', ');
          migrationSql += `INSERT INTO ${quoteIdent(`${tableName}__d1_sync_new`)} (${cols}) SELECT ${cols} FROM ${quoteIdent(tableName)};\n`;
        }
        migrationSql += `DROP TABLE ${quoteIdent(tableName)};\n`;
        migrationSql += `ALTER TABLE ${quoteIdent(`${tableName}__d1_sync_new`)} RENAME TO ${quoteIdent(tableName)};\n`;
      } else {
        const remoteColNames = new Set(remoteCols.map(c => c.name));
        for (const col of columns) {
          if (!remoteColNames.has(col.name)) {
            console.log(`Column ${col.name} is new in table ${tableName}.`);
            let colDef = `${quoteIdent(col.name)} ${col.type}`;
            if (col.notnull) colDef += ' NOT NULL';
            if (col.dflt_value !== 'null' && col.dflt_value !== null && col.dflt_value !== '') {
              colDef += ` DEFAULT ${col.dflt_value}`;
            }
            migrationSql += `ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${colDef};\n`;
          }
        }
      }
    }
  }
  
  // Check for dropped tables
  for (const tableName of Object.keys(remoteTables)) {
    if (!localTables[tableName]) {
      console.log(`Table ${tableName} was removed.`);
      migrationSql += `DROP TABLE IF EXISTS ${tableName};\n`;
    }
  }

  // Check for new, modified, or dropped indexes
  for (const idx of localIndexes) {
    if (!idx.sql) continue;
    const normalized = idx.sql.trim().replace(/\s+/g, ' ').toLowerCase();
    const remoteIdx = remoteIndexes.find(r => r.name === idx.name);
    const createIndexSql = idx.sql.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/i, 'CREATE $1INDEX IF NOT EXISTS ');

    if (needsForeignKeysOff) {
      migrationSql += `${createIndexSql};\n`;
    } else if (!remoteIdx) {
      console.log(`Index is new: ${idx.name}`);
      migrationSql += `${idx.sql};\n`;
    } else {
      const remoteNormalized = remoteIdx.sql.trim().replace(/\s+/g, ' ').toLowerCase();
      if (remoteNormalized !== normalized) {
        console.log(`Index ${idx.name} changed. Recreating...`);
        migrationSql += `DROP INDEX IF EXISTS ${idx.name};\n${idx.sql};\n`;
      }
    }
  }

  for (const remoteIdx of remoteIndexes) {
    if (!localIndexes.some(l => l.name === remoteIdx.name)) {
      console.log(`Index ${remoteIdx.name} was removed.`);
      migrationSql += `DROP INDEX IF EXISTS ${remoteIdx.name};\n`;
    }
  }

  unlinkSync(tempLocalDb);

  if (!migrationSql) {
    console.log('No changes detected.');
    return;
  }

  if (needsForeignKeysOff) {
    migrationSql = `PRAGMA foreign_keys=off;\n${migrationSql}PRAGMA foreign_keys=on;\n`;
  }

  if (args.values['dry-run']) {
    console.log('\n--- DRY RUN: Migration SQL ---\n');
    console.log(migrationSql);
    console.log('------------------------------\n');
    return;
  }

  const tempMigrationFile = path.join(cwd, '.d1_sync_temp_migration.sql');
  writeFileSync(tempMigrationFile, migrationSql);
  console.log('Executing changes...');

  if (!args.values['remote-only']) {
    console.log('Applying changes locally...');
    spawnSync('npx', ['wrangler', 'd1', 'execute', DB_NAME, '--local', '--file', tempMigrationFile], { stdio: 'inherit', cwd });
  }

  if (!args.values['local-only']) {
    console.log('Applying changes remotely...');
    spawnSync('npx', ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--file', tempMigrationFile], { stdio: 'inherit', cwd });
  }
  
  unlinkSync(tempMigrationFile);
  console.log('Done!');
}

main().catch(console.error);
