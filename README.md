# eduapp — Ubuntu operations bridge

This repository contains an initial, restricted bridge between GitHub Actions and a test Ubuntu server.

## Important security boundaries

- The repository is public. **Never commit SSH private keys, passwords, or tokens.**
- This bridge uses a **GitHub-hosted runner** over SSH; it does not install a self-hosted runner on the server.
- It logs in as the unprivileged `eduappbot` account (not root).
- Its SSH key is constrained by a forced command allowing only a read-only `status` operation.
- Editing `ops/request.json` on `main` triggers the workflow. The `request_id` may be changed to trigger a fresh run.
- This first version intentionally does **not** provide arbitrary shell, sudo, deployment, Docker operations or access to secrets. Future actions should be added through reviewed, narrowly scoped server scripts.

## One-time Ubuntu setup

Run the setup script as root **after reviewing it**. You can copy this repo to the server or copy the contents of `scripts/bootstrap-ubuntu.sh` into a local script.

```bash
bash scripts/bootstrap-ubuntu.sh
```

The script creates `eduappbot`, a restricted SSH command, and a dedicated SSH key pair in `/root/eduapp-gh-bridge/`.

## GitHub secret setup

In repository **Settings → Secrets and variables → Actions → New repository secret**, add:

- `UBUNTU_SSH_HOST`: Ubuntu server public IP or hostname.
- `UBUNTU_SSH_PRIVATE_KEY`: Complete private key content from `/root/eduapp-gh-bridge/github_actions_ed25519`; **paste it directly in the GitHub secret UI, never into a chat or repository file**.
- `UBUNTU_SSH_KNOWN_HOSTS`: One line `[HOST]:2233 ssh-ed25519 BASE64_HOST_PUBLIC_KEY`, using the **verified** server host public key from `/etc/ssh/ssh_host_ed25519_key.pub`, not an unverified `ssh-keyscan` result.

The workflow uses SSH port `2233` and user `eduappbot`. Confirm the server firewall and SSH daemon permit public-key login for `eduappbot`.

After the secret is saved, delete the temporary private key **from the server** (`/root/eduapp-gh-bridge/github_actions_ed25519`), leaving the public key and authorized_keys entry.

## Trigger

1. Open `ops/request.json` and increment `request_id` (for example `001` → `002`).
2. Commit the change to `main`, or select `Actions → Ubuntu status bridge → Run workflow`.
3. Inspect the workflow logs for a server status report. No server write operation is performed.

Current action allowlist: **status** only.

Security: Do not add a self-hosted GitHub Actions runner to this public repository. Limit who can push to the default branch and review workflow edits.


## v2: isolated preview operations (opt-in)

The v2 files are committed, but **the server is not upgraded until the operator runs the installer**.

### Install v2 on Ubuntu

```bash
cd /root/eduapp
git pull --ff-only
# Review scripts/upgrade-bridge-v2.sh and scripts/eduapp-preview-deploy.py before running.
bash scripts/upgrade-bridge-v2.sh
```

The installer preserves the existing `eduappbot` SSH key and host SSH configuration. It creates `eduapp-preview.service` and serves only `127.0.0.1:18080` from a dedicated `/var/lib/eduapp-preview` directory. Nginx, Docker and existing virtual hosts are not modified. Do **not** expose port 18080 to the internet until a separately reviewed public reverse-proxy route is deliberately installed.

### Test v2

Visit [Ubuntu preview operations](https://github.com/ostaddehdari/eduapp/actions/workflows/ubuntu-preview-ops.yml), select **Run workflow**, and use the dropdown. Actions available:

- `status`: basic host and systemd service status
- `inventory`: bounded read-only system inventory
- `logs`: last 80 lines of this preview's own deployment log
- `test`: HTTP smoke test to localhost:18080
- `deploy-static`: copy only regular files in `preview/` from the current `main` commit, at most 250 files and 20 MB, into a new release and atomically switch
- `rollback`: restore previous deployed release

The first deployment should be tested with `status`, `test`, and then `deploy-static` (with the workflow branch set to `main`). Next run `test` again.

The existing SSH GitHub secrets are reused. The old `Ubuntu status bridge` workflow still works.

### Scope

This v2 is a **static-site preview deployment**, not a general shell, Node runtime, Docker controller, arbitrary command execution, or public web deployment. To deploy backend software, create a narrowly scoped application-specific service/deployment operation after reviewing existing server layout, firewall, GitHub permissions and recovery needs.

Do not allow unknown contributors to modify Actions workflows on `main`, since workflows are executable code in GitHub-hosted runners.
