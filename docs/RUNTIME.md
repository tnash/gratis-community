# Headless runtime in your own cloud account

`gratis-runtime` runs Gratis bots, schedules, objectives, controls, knowledge notes and the team board without the desktop app, so scheduled work continues while your Mac is closed. You supply the machine and the account. Nothing here deploys to anyone else's infrastructure, and this repository operates no hosted service.

Status: early. Read "What it cannot do yet" before relying on it. The install and run steps below were checked on a clean copy on macOS. The systemd and SSH tunnel steps were not run on a cloud server.

## What you need

- A small Linux VM at any provider you control (about 1 vCPU, 2 GB RAM, and at least 4 GB free disk: dependencies are about 1.3 GB).
- Node.js 22.16 or newer, and git.
- A Claude or Codex login made **on that VM** (see step 5). Gratis does not hold provider credentials.
- Confirmation that your provider's terms allow using your subscription on a remote machine. This is not settled here. If it is not allowed, use a provider and plan that is.

## 1. Create an unprivileged user

Run the runtime as its own user so a compromised bot has little to reach.

```sh
sudo adduser --disabled-password --gecos "" gratis
sudo -iu gratis
```

## 2. Install

```sh
git clone https://github.com/tnash/gratis-community.git
cd gratis-community
npm ci --omit=dev --ignore-scripts
```

`--omit=dev` skips Electron, which a server does not need. `--ignore-scripts` skips the repository's git-hook setup.

## 3. Create the runtime

Choose a passphrase of at least 12 characters. It derives the key that encrypts everything the runtime stores. If you lose it the data cannot be recovered, and Gratis cannot reset it.

```sh
export GRATIS_RUNTIME_PASSPHRASE='your long passphrase'
node scripts/gratis-runtime.mjs init --data ~/gratis-data
```

`init` prints an **admin token once**. Save it in your password manager. Only a hash is stored.

## 4. Run it as a service

Put the passphrase in a file only the `gratis` user can read:

```sh
install -m 600 /dev/null ~/runtime.env
echo "GRATIS_RUNTIME_PASSPHRASE=your long passphrase" > ~/runtime.env
```

Create `/etc/systemd/system/gratis-runtime.service` as root, replacing the paths if yours differ:

```ini
[Unit]
Description=Gratis headless runtime
After=network-online.target

[Service]
User=gratis
WorkingDirectory=/home/gratis/gratis-community
EnvironmentFile=/home/gratis/runtime.env
ExecStart=/usr/bin/node scripts/gratis-runtime.mjs run --data /home/gratis/gratis-data --port 7421
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now gratis-runtime
journalctl -u gratis-runtime -f
```

Keeping the passphrase in a file on the same machine protects the data from copies of the data directory, not from someone who controls the VM. Run only one runtime per data directory; a second one refuses to start.

## 5. Sign in to Claude or Codex on the VM

Gratis runs the official command-line clients and uses their login. Install the one you use by following the vendor's current instructions, then sign in as the `gratis` user. On a server without a browser, use the client's link or device login and finish it in a browser on your own computer.

```sh
node scripts/gratis-runtime.mjs status
```

`status` reports whether Claude and Codex are installed and signed in. Subscription limits apply, and unattended scheduled runs count against them.

## 6. Choose the provider

The runtime starts on the built-in demo provider. Switch with an admin token once a login shows as signed in:

```sh
curl -s -X POST localhost:7421/settings -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"provider":"claude","model":"sonnet"}'
```

The route refuses a provider that is not signed in. Bots only receive their tools (schedules, objectives, knowledge, team board, web, files) with the `claude` or `codex` provider.

## 7. Reach it safely

The runtime listens on `127.0.0.1` only and has no TLS of its own. Do not open port 7421 in the cloud firewall. Use an SSH tunnel from your computer:

```sh
ssh -N -L 7421:127.0.0.1:7421 gratis@your-server
curl -s -H "Authorization: Bearer $TOKEN" localhost:7421/status
```

Create narrower tokens for anything else, and revoke them at any time (effective on the next request):

```sh
node scripts/gratis-runtime.mjs token read --data ~/gratis-data   # read, run or admin
curl -s -X POST localhost:7421/tokens/revoke -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"id":"<token id from GET /tokens>"}'
```

Routes: `GET /status`, `GET /state`, `GET /settings`, `POST /send`, `POST /approval`, `POST /settings` (admin), `GET|POST /tokens` and `POST /tokens/revoke` (admin).

## Update and back up

```sh
cd ~/gratis-community && git pull && npm ci --omit=dev --ignore-scripts
sudo systemctl restart gratis-runtime
```

Back up the whole data directory (`~/gratis-data`). It is encrypted, and useless without the passphrase. Stop the service before copying for a consistent copy.

## What it cannot do yet

- **No desktop client.** The desktop app does not connect to the runtime, and there is no workspace move between them. The runtime is a separate profile with its own data directory.
- **No UI, and no notifications.** You manage it with the routes above. Approvals a bot needs wait in the runtime; nothing alerts you.
- **No computer control, Gmail, memory, T3 or phone relay** on the runtime.
- **No Docker image or built-in TLS.** Use the SSH tunnel, or put your own TLS proxy in front.
- **Passphrase from an environment variable.** A keystore or prompt is a better fit for a shared server.
