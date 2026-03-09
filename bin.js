#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const args = parseArgs({
  options: {
    schema: { type: 'string', short: 's', default: './db/schema.sql' },
    migrations: { type: 'string', short: 'm', default: './migrations' },
    db: { type: 'string', short: 'd' },
    name: { type: 'string', short: 'n', default: 'auto_migration' },
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
  -m, --migrations <path>  Path to your migrations directory (default: ./migrations)
  -d, --db <name>          Database name (default: parses from wrangler.toml/jsonc)
  -n, --name <name>        Name of the migration (default: auto_migration)
      --dry-run            Print the generated SQL without applying or saving it
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
const MIGRATIONS_DIR = path.resolve(cwd, args.values.migrations);

async function main() {
  if (!existsSync(SCHEMA_FILE)) {
    console.error(`Error: Schema file not found at ${SCHEMA_FILE}`);
    process.exit(1);
  }

  console.log(`Fetching remote schema for "${DB_NAME}"...`);
  const remoteResult = spawnSync('npx', ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--command', "SELECT sql FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL", '--json'], { encoding: 'utf8', cwd });
  
  if (remoteResult.status !== 0) {
    console.error('Failed to fetch remote schema:', remoteResult.stderr);
    process.exit(1);
  }

  const remoteRows = JSON.parse(remoteResult.stdout)[0].results;
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
  
  const localIndexesSql = spawnSync('sqlite3', [tempLocalDb, "SELECT sql FROM sqlite_master WHERE type = 'index'"], { encoding: 'utf8' }).stdout.trim().split('\n');
  const remoteIndexesSql = remoteRows.filter(r => r.sql.startsWith('CREATE INDEX')).map(r => r.sql);

  const schemaSql = readFileSync(SCHEMA_FILE, 'utf8');
  unlinkSync(tempLocalDb);

  let migrationSql = '';
  
  for (const [tableName, columns] of Object.entries(localTables)) {
    if (!remoteTables[tableName]) {
      console.log(`Table ${tableName} is new.`);
      const regex = new RegExp(`CREATE TABLE (IF NOT EXISTS )?${tableName}\\s*\\(([^;]+)\\)`, 'i');
      const match = schemaSql.match(regex);
      if (match) {
        migrationSql += `CREATE TABLE IF NOT EXISTS ${tableName} (${match[2]});\n`;
      } else {
        const sql = spawnSync('sqlite3', [tempLocalDb, `SELECT sql FROM sqlite_master WHERE name='${tableName}'`], { encoding: 'utf8' }).stdout.trim();
        if (sql) migrationSql += `${sql};\n`;
      }
    } else {
      const remoteCols = new Set(remoteTables[tableName].map(c => c.name));
      for (const col of columns) {
        if (!remoteCols.has(col.name)) {
          console.log(`Column ${col.name} is new in table ${tableName}.`);
          let colDef = `${col.name} ${col.type}`;
          if (col.notnull) colDef += ' NOT NULL';
          if (col.dflt_value !== 'null' && col.dflt_value !== null && col.dflt_value !== '') {
            colDef += ` DEFAULT ${col.dflt_value}`;
          }
          migrationSql += `ALTER TABLE ${tableName} ADD COLUMN ${colDef};\n`;
        }
      }
    }
  }
  
  for (const indexSql of localIndexesSql) {
    if (!indexSql) continue;
    const normalized = indexSql.trim().replace(/\s+/g, ' ').toLowerCase();
    const exists = remoteIndexesSql.some(r => r.trim().replace(/\s+/g, ' ').toLowerCase() === normalized);
    if (!exists) {
      console.log(`Index is new: ${indexSql}`);
      migrationSql += `${indexSql};\n`;
    }
  }

  if (!migrationSql) {
    console.log('No changes detected.');
    return;
  }

  if (args.values['dry-run']) {
    console.log('\n--- DRY RUN: Migration SQL ---\n');
    console.log(migrationSql);
    console.log('------------------------------\n');
    return;
  }

  if (!existsSync(MIGRATIONS_DIR)) mkdirSync(MIGRATIONS_DIR, { recursive: true });
  
  // Find the next migration number
  const existingFiles = readdirSync(MIGRATIONS_DIR);
  const highestNumber = existingFiles
    .map(f => {
      const match = f.match(/^(\d{4})_/);
      return match ? parseInt(match[1], 10) : 0;
    })
    .reduce((max, current) => Math.max(max, current), 0);
  
  const nextNumber = (highestNumber + 1).toString().padStart(4, '0');
  const migrationPath = path.join(MIGRATIONS_DIR, `${nextNumber}_${args.values.name}.sql`);
  writeFileSync(migrationPath, migrationSql);
  console.log(`Migration created: ${migrationPath}`);

  if (!args.values['remote-only']) {
    console.log('Applying migration locally...');
    spawnSync('npx', ['wrangler', 'd1', 'execute', DB_NAME, '--local', '--file', migrationPath], { stdio: 'inherit', cwd });
  }

  if (!args.values['local-only']) {
    console.log('Applying migration remotely...');
    spawnSync('npx', ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--file', migrationPath], { stdio: 'inherit', cwd });
  }
  
  console.log('Done!');
}

main().catch(console.error);
