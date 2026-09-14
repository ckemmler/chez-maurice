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
  because it refuses any request that is not local. Reach it with `ssh -L`.

## The first time, on a fresh machine

1. **The machine.** `infra/cloud-init/maurice.yaml` as its user data: it
   installs Docker, makes `/opt/maurice`, and does nothing else. Put your own
   ssh key in it first.
2. **The shared secrets**, once, on the host: `/opt/maurice/defaults.env`
   holding what every household needs (the embedding endpoint and key —
   `CORPUS_EMBEDDING_*`, see `.env.prod.example`). Every household's env file
   starts as a copy of it.
3. **The image and the compose files**: `scripts/deploy.sh <ssh-host>` builds
   here and ships there.
4. **The door**: `ops/household.sh edge <ssh-host>`.
5. **A household**: `ops/household.sh add <ssh-host> aline aline.chezmaurice.eu`,
   then point that name at the machine with a plain A record — **unproxied**.
   Whoever proxies the traffic terminates the TLS and reads the clear text,
   which is the line this arrangement exists to stay on the right side of.
6. **Finish the setup** through the tunnel the command prints:
   `ssh -L <port>:localhost:<port> <host>`, then `/admin`.

## Afterwards

```
ops/household.sh list    <host>            who lives here, and is it running
ops/household.sh up      <host> <name>     (re)start one
ops/household.sh restart <host> <name>
ops/household.sh remove  <host> <name>     stop it, keep its data
ops/household.sh purge   <host> <name>     stop it, delete its data
scripts/deploy.sh        <host> [tag]      a new image for everyone on the host
```

A new version reaches a household when its container is recreated on the new
image; `deploy.sh` ships the image, `ops/household.sh up <host> <name>` picks
it up. `ops/fleet-status.sh` and `ops/tower.ts` watch what is running where —
add the household's public name to `ops/fleet.yaml` when you add it here.

## Moving a household off this machine

The point of hosting a friend's Maurice is to hand it back. Everything that
household owns is in one docker volume:

```
docker run --rm -v maurice-<name>_home:/v -v "$PWD":/out busybox \
  tar czf /out/<name>.tar.gz -C /v .
```

Restore it into a volume on their own machine, point the name at it, and
`ops/household.sh purge` here. `ops/README.md` has the rest of the hand-over.
