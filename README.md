# d1-sync

A minimalistic, zero-config `schema.sql` syncing tool for Cloudflare D1.

Instead of managing ORM states, manually writing `ALTER TABLE` migrations, or tracking migration files, `d1-sync` treats your raw `schema.sql` as the single source of truth. It fetches the current schema from your production D1 database, compares it with your local `schema.sql`, and automatically applies the necessary changes (creating tables, adding columns, dropping tables, managing indexes) directly via `wrangler d1`.

No migration files are generated or tracked. It just syncs your D1 database to match your schema file.

## Features
- **No ORMs or Migration Files:** Write pure SQL in your `schema.sql`. The tool handles the sync directly.
- **Zero Configuration:** Automatically infers database name from `wrangler.toml` or `wrangler.json(c)`.
- **Reliable Diffing:** Diffing happens against the actual *live* D1 database schema to prevent drift.
- **Fast:** Powered natively by `sqlite3` CLI and Node.js.

## Requirements
- `sqlite3` CLI installed on your system (pre-installed on macOS and most Linux distros).
- A Cloudflare Workers project with Wrangler and D1 configured.

## Installation

```bash
npm install -D d1-sync
```

## Usage

Make a change in your `db/schema.sql` (e.g., adding a column or table), and then run:

```bash
npx d1-sync
```

### Options

```text
Usage: d1-sync [options]

Options:
  -s, --schema <path>      Path to your schema.sql file (default: ./db/schema.sql)
  -d, --db <name>          Database name (default: parses from wrangler.toml/jsonc)
      --dry-run            Print the generated SQL without applying it
      --local-only         Only apply the changes to the local D1 database
      --remote-only        Only apply the changes to the remote D1 database
  -h, --help               Show this help message
```

## Limitations
- **SQLite constraints:** SQLite has limited `ALTER TABLE` support. `d1-sync` supports creating new tables, creating/modifying indexes, adding new columns, and dropping tables/indexes. Modifying or dropping existing columns requires table recreation, which is not currently automated to prevent accidental data loss.
