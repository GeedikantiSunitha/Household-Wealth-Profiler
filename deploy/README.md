# deploy: where and how the app runs

| Folder | Holds | When |
| --- | --- | --- |
| `local/` | Running the app on your own machine: `dev.js` is `npm run dev` (demo login, no encryption, data in `./data-dev`, any `.env` database ignored; development only). `npm start` runs the real set-up from `.env` | Done |
| `dcdeploy/` | DCDeploy services: web, api, database and the backup job; setting names per environment | When hosting is decided |

Setting **names** live here, never their values. Values go in the hosting platform's secret
settings or a local `.env`, which git ignores.

The older deploy files (`Dockerfile`, `fly.toml`, `scripts/deploy-fly.sh`,
`scripts/deploy-supabase.sh`) stay where they are until they are replaced or retired.
