# Several households on one machine

`compose.prod.yml` is one Maurice and its own Caddy — the right shape for a
machine a client owns. This is the other shape: a host that carries several
households, which is how Aline, the App Review instance, friends' instances
and the demo fleet get served without a machine each.

Measured on the production image, idle: **~260 MB per household**, plus ~15 MB
for Caddy. A 8 GB machine therefore holds around twenty; 16 GB, forty. (Before
September 2026 a household ran one Astro dev server per member and cost two to
three times that — see `docs/garden-server-mode.md`.)

## The shape

```
              :80 :443
                 │
         ┌───────▼────────┐   maurice-edge (a docker network, nothing published)
         │  maurice-caddy │
         └──┬────────┬────┘
            │        │       one container per household, reachable by name
   maurice-aline  maurice-review   …          only from this network
      │               │
   volume          volume          one per household: databases, gardens, files
 maurice-aline_home  maurice-review_home
```

- **One compose project per household** (`maurice-<name>`), so its volume is
  its own and two households cannot reach each other's data by accident.
- **One shared Caddy**, the only thing with a published port. It routes by the
  name in the request, gets a certificate per name from Let's Encrypt, and
  refuses a name it was never told about.
- **`sites/<name>.caddy`** is what tells it about a name. Adding a household is
  a new file and a reload — never an edit to a file someone else's household
  depends on, and never a restart of the others.
- **The admin console** is published on loopback only, one port per household,
  because it refuses any request that is not local. Reach it with `ssh -L`, or
  let `ops/admin.ts <household>` do it (`admin: ssh://<host>:<port>` in
  `ops/fleet.yaml`, the tower's `a` key).

## The first time, on a fresh machine

1. **The machine.** `infra/cloud-init/maurice.yaml` as its user data: it
   installs Docker, makes `/opt/maurice`, and does nothing else. Put your own
   ssh key in it first.
2. **The shared settings**, once, on the host: `/opt/maurice/defaults.env`
   holding what every household needs — the embedding endpoint and key
   (`CORPUS_EMBEDDING_*`, see `.env.prod.example`) and `MAURICE_ACME_EMAIL`,
   the address Let's Encrypt writes to about certificates. Every household's
   env file starts as a copy of it, and the edge reads it too.
3. **The image and the compose files**: `scripts/deploy.sh <ssh-host>` builds
   here and ships there. Through a registry, or it pipes 2 GB over ssh every
   time: `export MAURICE_REGISTRY=rg.fr-par.scw.cloud/<namespace>` here, and on
   the host, once, `docker login rg.fr-par.scw.cloud -u nologin` with a secret
   key that can only read that registry.
4. **The door**: `ops/household.sh edge <ssh-host>`.
5. **A household**: `ops/household.sh add <ssh-host> aline aline.chezmaurice.eu`,
   then point that name at the machine with a plain A record — **unproxied**.
   Add `--from <archive>` to start it from a household archive instead of
   empty (`docs/household-archive.md`): a demo becoming someone's own, or a
   household moving host.
   Whoever proxies the traffic terminates the TLS and reads the clear text,
   which is the line this arrangement exists to stay on the right side of.
6. **Finish the setup** through the tunnel the command prints:
   `ssh -L <port>:localhost:<port> <host>`, then `/admin`. Once the household
   has a line in `ops/fleet.yaml` with that port as `admin: ssh://<host>:<port>`,
   `ops/admin.ts <name>` is the same thing in one word.

## Afterwards

```
ops/household.sh list    <host>            who lives here, and is it running
ops/household.sh up      <host> <name>     (re)start one
ops/household.sh restart <host> <name>
ops/household.sh remove  <host> <name>     stop it, keep its data
ops/household.sh purge   <host> <name>     stop it, delete its data
scripts/deploy.sh        <host> [tag]      a new image for everyone on the host
```

## Updating everyone

```
scripts/deploy.sh <host>
```

That is the whole update: build the image here, push it, and recreate every
household on the host onto it, one after the other — each is down for the few
seconds its container takes to answer `/healthz` again, and its data volume
never moves. The image shipped is recorded in `/opt/maurice/image.env`, which
`ops/household.sh` reads on every `up`, `restart` and `add`, so a restart
later lands on the same image. The previous image stays on the host for a
rollback (`MAURICE_IMAGE=<registry>/maurice:<old tag> ops/household.sh up
<host> <name>`); dangling layers are pruned. `ops/fleet-status.ts` and
`ops/tower.ts` show which version each household runs — add the household's
public name to `ops/fleet.yaml` when you add it here, with `deploy:
scripts/deploy.sh <host>` and `admin: ssh://<host>:<its loopback port>`. The
`add` command prints that entry ready to paste.

## Moving a household off this machine

The point of hosting a friend's Maurice is to hand it back. Everything that
household owns is in one docker volume:

```
docker run --rm -v maurice-<name>_home:/v -v "$PWD":/out busybox \
  tar czf /out/<name>.tar.gz -C /v .
```

Restore it into a volume on their own machine, point the name at it, and
`ops/household.sh purge` here. `ops/README.md` has the rest of the hand-over.
