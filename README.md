# d1-sync

A minimalistic, zero-config (almost) auto-migration tool for Cloudflare D1.

Instead of managing ORM states or manually writing `ALTER TABLE` migrations, `d1-sync` treats your raw `schema.sql` as the single source of truth. It fetches the current schema from your production D1 database, compares it with your local `schema.sql`, generates the necessary SQLite `ALTER TABLE` or `CREATE TABLE` commands, and automatically applies them via `wrangler d1`.

## Features
- **No ORM Required:** Write pure SQL in your `schema.sql`.
- **Zero Configuration:** Automatically infers database name from `wrangler.toml` or `wrangler.json(c)`.
- **Reliable Diffing:** Diffing happens against the actual *live* D1 database schema to prevent local drift.
- **Fast:** Powered natively by `sqlite3` CLI and Node.js.
- **Sequential Migrations:** Generates ordered migration files (e.g., `0001_init.sql`, `0002_add_users.sql`).

## Requirements
- `sqlite3` CLI installed on your system (pre-installed on macOS and most Linux distros).
- A Cloudflare Workers project with Wrangler and D1 configured.

## Installation

You can install it globally or add it as a dev dependency to your project:

```bash
npm install -D d1-sync
```

## Usage

Simply make a change in your `db/schema.sql` (e.g., adding a column or table), and then run:

```bash
npx d1-sync --name "my_new_feature"
```

### Options

```text
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
```

## How it works

1. **Fetch:** Executes a query against your remote D1 database to get the current schema.
2. **Load:** Loads your local `schema.sql` into an in-memory/temporary SQLite database.
3. **Compare:** Checks for missing tables and columns.
4. **Generate:** Creates a numbered `.sql` file in your `./migrations` folder.
5. **Apply:** Uses `wrangler d1 execute` to apply the migration locally and remotely.

## Limitations
- **SQLite constraints:** SQLite has limited `ALTER TABLE` support. `d1-sync` primarily supports creating new tables, creating new indexes, and adding new columns. Dropping or renaming columns requires table recreation, which is not currently automated to prevent accidental data loss.
