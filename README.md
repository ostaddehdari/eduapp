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
