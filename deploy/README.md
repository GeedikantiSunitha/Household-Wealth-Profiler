# deploy: where and how the app runs

| Folder | Holds | When |
| --- | --- | --- |
| `local/` | Running the app on your own machine: `dev.js` is `npm run dev` (demo login, no encryption, data in `./data-dev`, any `.env` database ignored; development only). `npm start` runs the real set-up from `.env`. `compose.yml` rehearses the two-service deployment (web tier, API, migration, PostgreSQL with the three roles) in containers; `check.js` is its smoke check, usable against any deployment. `compose.split.yml` (added with `-f`) rehearses the split-address mode, the page and the API on two ports, and `check-split.js` is its smoke check | Done |
| the images | `backend/Dockerfile` (the API alone, `SERVE_WEB=0`) and `frontend/Dockerfile` (nginx: the screens and `core.js` as they are, `/api/` passed to the API on the same domain; `nginx.conf.template` beside it). The `Dockerfile` at the root is the one-service image that serves the screens itself. Both are built from the repository root; the process is `ops/DEPLOYMENT.md` | Done |

Setting **names** live here, never their values. Values go in the hosting platform's secret
settings or a local `.env`, which git ignores.

The older Fly.io deploy files (`fly.toml`, `scripts/deploy-fly.sh`) stay where they are until they
are replaced or retired.
