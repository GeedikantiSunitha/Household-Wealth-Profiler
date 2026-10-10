# ops: running the service

Tools for operating a deployment, kept apart from the app itself.

| Folder | Holds | When |
| --- | --- | --- |
| `migrate-data/` | Copying existing data into PostgreSQL (today `node server.js import-files`) | Step B21 |
| `backup/` | Encrypted database backups to storage outside the hosting platform | Before go-live |
| `restore/` | Restoring a backup and checking it (record counts, records decrypt) | Before go-live |
| `admin/` | Firm administration (create firm, seats, suspend) | With multi-firm support |
| `keys/` | Creating and rotating the encryption key | With encryption version 2 |

Nothing here runs as part of the app, and nothing here may hold a password or key: settings
come from the environment.
