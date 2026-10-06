# Deploying the API on AWS EC2

One small server in Mumbai (`ap-south-1`, next to the Supabase database)
runs two containers from [`deploy/ec2/compose.yaml`](../deploy/ec2/compose.yaml):

- `api`: the `Dockerfile` image. It is never exposed directly.
- `caddy`: HTTPS on ports 80 and 443. It gets and renews the certificate
  ([`deploy/ec2/Caddyfile`](../deploy/ec2/Caddyfile)).

The daily jobs run inside the API (`RUN_JOBS=true`, one instance). Photos go to
Supabase Storage, so the server keeps nothing that a rebuild would lose.

> **Sydney for now (testing).** Accounts from AWS's simplified sign-up get one
> region chosen by country, and India gets Asia Pacific (Sydney)
> `ap-southeast-2`, with no region menu. Using Mumbai needs two permanent
> changes: upgrading to a paid plan and activating advanced features, which
> also removes the hard spend limit. Until then the server runs in Sydney.
> Follow this guide with these differences:
>
> - Read "Sydney" wherever it says Mumbai or `ap-south-1`, and skip the
>   region-menu steps.
> - Skip the budget in step 1. On the Free plan the account can't be charged.
> - Expect about 1–2 s per request. Each database round trip between Sydney
>   and Mumbai takes about 150 ms, and a request makes several. That's fine for
>   checking features, but don't judge speed from it.
>
> To move to Mumbai later, launch a new server there and repeat steps 2–9. The
> server holds no data. Then terminate the Sydney one and release its IP.

**Cost.** A t4g.small with its public IP and a 20 GiB disk is roughly $15 a
month. The Free plan's credits ($100 at sign-up, up to $100 more) cover about
six months. The Free plan ends after 6 months, or sooner if the credits run out.
Upgrade to a paid plan before then or the account is closed (see
[After six months](#after-six-months)).

## Before you start

- **Push the code.** The server deploys what is on GitHub
  (`git@github.com:khuntkk/FT-Backend.git`), not what is on your laptop.
- **Your working `.env` and `certs/supabase-ca.crt`.** The API must already run
  locally against Supabase (README "First run").
- **A domain for the API**, for example `api.yourdomain.com`. You need to be
  able to add a DNS record for it. With no domain yet, use `sslip.io`. It
  names an IP address, so `13.234.10.20` becomes `13-234-10-20.sslip.io`, and
  needs no setup. That's fine for testing. Use a real domain before the apps
  go to real users.

In the commands below, replace:

| Placeholder        | With                                                   |
|--------------------|--------------------------------------------------------|
| `<IP>`             | The server's Elastic IP (step 3)                       |
| `<API_DOMAIN>`     | `api.yourdomain.com` or `13-234-10-20.sslip.io`        |
| `<KEY>`            | Path to the key pair file, e.g. `~/.ssh/stitchflow-ec2.pem` |

## 1. AWS account

1. Sign up at aws.amazon.com and choose the **Free plan**.
2. In the console's top-right region menu, pick **Asia Pacific (Mumbai)
   ap-south-1**. Every step below happens in this region.
3. **Billing and Cost Management → Budgets → Create budget.** Use a monthly cost
   budget of $20 with an email alert. Creating a budget also earns Free plan
   credits. Check **Billing → Credits** now and then to see what's left.

## 2. Launch the server

**EC2 → Instances → Launch instances:**

| Setting                    | Value                                                         |
|----------------------------|---------------------------------------------------------------|
| Name                       | `stitchflow-api`                                              |
| Application and OS Images  | **Ubuntu Server 24.04 LTS**, architecture **64-bit (Arm)**    |
| Instance type              | **t4g.small** (2 GiB memory)                                  |
| Key pair                   | **Create new key pair**: `stitchflow-ec2`, ED25519, `.pem`. Save it as `<KEY>`. |
| Network settings → Firewall | Create security group. Tick **Allow SSH traffic from: My IP**, **Allow HTTPS traffic from the internet** and **Allow HTTP traffic from the internet**. |
| Configure storage          | 20 GiB gp3                                                    |

Caddy needs HTTP (80) for the certificate challenge and the redirect to HTTPS.
SSH is open only to your current IP. If your IP changes, edit the security
group's SSH rule.

If the Free plan marks only some instance types as eligible, pick t4g.small or
t3.small from those. If you pick t3.small (x86), choose the **64-bit (x86)**
image instead. Nothing else changes, because the image is built on the server.

## 3. Give it a fixed IP

**EC2 → Network & Security → Elastic IPs → Allocate Elastic IP address →
Allocate.** Select it, then **Actions → Associate Elastic IP address** and pick
`stitchflow-api`.

That address is `<IP>`. It stays the same across stops and restarts.

## 4. Point the domain at it

At your DNS provider, add an **A record**: `api` (or whichever name you chose)
→ `<IP>`. Check it from your laptop before going on. Caddy can't get a
certificate until this resolves:

```bash
dig +short <API_DOMAIN>
```

Skip this step if you use `sslip.io`.

## 5. Prepare the server

From your laptop:

```bash
chmod 400 <KEY>
```

```bash
ssh -i <KEY> ubuntu@<IP>
```

Run the rest of this section on the server. First apply updates and add 2 GiB
of swap, as headroom for image builds:

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Install Docker from Docker's own apt repository:

```bash
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker ubuntu
```

Sign out (`exit`) and SSH in again so the `docker` group applies. Then check:

```bash
docker compose version
```

Docker starts on boot, and the containers use `restart: unless-stopped`, so a
reboot brings the API back up by itself. Ubuntu installs security updates
automatically (unattended-upgrades).

## 6. Get the code

Give the server read-only access to the repository with a deploy key:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N "" -C "stitchflow-ec2"
printf 'Host github.com\n  IdentityFile ~/.ssh/github_deploy\n' >> ~/.ssh/config
cat ~/.ssh/github_deploy.pub
```

On GitHub, go to the repo's **Settings → Deploy keys → Add deploy key**. Paste
the key and leave **Allow write access** off. Then clone:

```bash
git clone git@github.com:khuntkk/FT-Backend.git ~/stitchflow
mkdir -p ~/stitchflow/certs
```

## 7. Secrets

From your laptop, in the FT-Backend folder, copy the environment and the
database CA. Neither is in git.

```bash
scp -i <KEY> .env ubuntu@<IP>:~/stitchflow/.env
```

```bash
scp -i <KEY> certs/supabase-ca.crt ubuntu@<IP>:~/stitchflow/certs/
```

On the server, lock the file down and give the server its own signing key:

```bash
chmod 600 ~/stitchflow/.env
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" ~/stitchflow/.env
nano ~/stitchflow/.env
```

In the editor, check:

- `DATABASE_SSL=verify` and `DATABASE_CA_FILE=certs/supabase-ca.crt`.
- `RUN_JOBS=true`.
- `CORS_ORIGINS`: the web admin panel's origin, if it's hosted on its own
  domain (for example `https://admin.yourdomain.com`). Leave it empty for now
  otherwise.

You don't need to set `HOST`, `PORT` or `TRUST_PROXY`. `compose.yaml` sets them.

Your laptop and this server now use the **same Supabase project**, so they
share the same data. Run a separate Supabase project for development if that
becomes a problem.

## 8. First deploy

Tell Caddy the domain, then deploy:

```bash
echo "API_DOMAIN=<API_DOMAIN>" > ~/stitchflow/deploy/ec2/.env
~/stitchflow/deploy/ec2/deploy.sh
```

[`deploy.sh`](../deploy/ec2/deploy.sh) does four things:

1. Pulls the latest code.
2. Builds the image.
3. Runs the migrations as the schema owner (`MIGRATION_DATABASE_URL`).
4. Starts or restarts the containers.

The first build takes a few minutes. Then check, from the server or your
laptop:

```bash
curl -s https://<API_DOMAIN>/health
```

It should print `{"ok":true}`. If the database already has a console admin
from local development, skip the next command. Otherwise make the first one:

```bash
cd ~/stitchflow/deploy/ec2 && docker compose run --rm --no-deps api node src/jobs/createPlatformAdmin.ts --email you@example.com --name "Your Name"
```

## 9. Point the apps at it

- **Flutter apps.** Either build with
  `--dart-define=STITCHFLOW_API=https://<API_DOMAIN>`, or enter the address in
  the app's Settings screen. An address already saved on a phone wins over the
  build's.
- **Web admin panel.** Build it with `VITE_API_URL=https://<API_DOMAIN>`. Host
  the static files anywhere, then put the panel's origin in `CORS_ORIGINS` (step
  7) and recreate the API so it picks the change up:

  ```bash
  cd ~/stitchflow/deploy/ec2 && docker compose up -d --force-recreate api
  ```

## Everyday use

Run all of these on the server, from `~/stitchflow/deploy/ec2`.

| Task                      | Command                                                     |
|---------------------------|-------------------------------------------------------------|
| Deploy what's on GitHub   | `./deploy.sh`                                               |
| Status and health         | `docker compose ps`                                         |
| API logs (live)           | `docker compose logs -f api`                                |
| Caddy logs (certificates) | `docker compose logs caddy`                                 |
| Restart the API           | `docker compose restart api`                                |
| After editing `.env`      | `docker compose up -d --force-recreate api`                 |
| Run the daily jobs now    | `docker compose exec api node src/jobs/run.ts`              |
| Disk use                  | `df -h /` and `docker system df`                            |

Logs are capped at 50 MB per container.

**Stopping to save credits.** Stopping the instance in the EC2 console ends the
compute charge. The Elastic IP and the disk still cost a little. Starting it
again brings everything back with the same address.

## Troubleshooting

- **No certificate / browser shows an error.** Check `docker compose logs caddy`.
  The usual causes are DNS not pointing at `<IP>` yet, or port 80 or 443
  missing from the security group.
- **502 from Caddy.** The API isn't running. `docker compose logs api` shows
  why. Typical causes are a missing variable (the error names it) or the
  database CA file missing from `~/stitchflow/certs`.
- **`self-signed certificate` / TLS errors to the database.** The CA file
  doesn't match the Supabase project. Download it again (Database settings →
  SSL).
- **A migration fails during `deploy.sh`.** The deploy stops before
  restarting, so the old API keeps serving. Fix the migration, push, and run
  `./deploy.sh` again.
- **Can't SSH in.** Your IP changed. Update the security group's SSH rule to
  **My IP**.

## After six months

The Free plan ends six months after sign-up, or sooner if the credits run out.
Before then, choose one:

- **Upgrade to a paid plan** (Billing → Upgrade plan). The server keeps running
  as it is. Unused credits stay valid until 12 months after sign-up, and after
  that it's about $15 a month.
- **Move.** On any other host that runs Docker, copy `.env`, `certs/` and
  `deploy/ec2/`, run `deploy.sh`, and move the DNS record. Nothing on this
  server needs to be carried over.
