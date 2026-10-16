# ops: running the service

Tools for operating a deployment, kept apart from the app itself. The step-by-step deployment
process (checks before, the database and its roles, migrations, the DCDeploy service and its
variables, validation after, backups, rollback, troubleshooting) is [DEPLOYMENT.md](DEPLOYMENT.md).

| Folder | Holds | When |
| --- | --- | --- |
| `migrate-data/` | One-off data migrations between storage set-ups. (Copying a file store into PostgreSQL is part of the API itself, `node server.js import-files` in `backend/src/cli/import-files.js`, because it uses the API's own storage code.) | When a migration is needed |
| `backup/` | Encrypted database backups to storage outside the hosting platform. The backup itself is part of the API, `node server.js backup` (`backend/src/cli/backup.js`), because it uses the API's own encryption; this folder is for the scheduling and the off-platform copy | Scheduling: when hosting is decided |
| `restore/` | Restoring a backup and checking it: `node server.js restore-drill` (`backend/src/cli/restore.js`) restores into a scratch database and checks counts, migrations, triggers, that every record decrypts and that firms stay apart | Done (Phase 4); run monthly |
| `admin/` | Firm administration (create firm, seats, suspend) | With multi-firm support |
| `keys/` | Creating and rotating the encryption key | With encryption version 2 |

Nothing here runs as part of the app, and nothing here may hold a password or key: settings
come from the environment.
