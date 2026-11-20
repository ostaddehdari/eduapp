#!/usr/bin/env python3
"""Safe static preview deployer: only copies validated assets, never runs repo scripts."""
import fcntl
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone

BASE = Path("/var/lib/eduapp-preview")
RELEASES = BASE / "releases"
CURRENT = BASE / "current"
PREVIOUS = BASE / "previous"
LOG = BASE / "ops.log"
REPO = "https://github.com/ostaddehdari/eduapp.git"
MAX_TOTAL = 20 * 1024 * 1024
MAX_FILES = 250

def log(message):
    stamp = datetime.now(timezone.utc).isoformat()
    with LOG.open("a", encoding="utf-8") as f:
        f.write(f"{stamp} {message}\n")

def link_target(link):
    if not link.is_symlink():
        return None
    rel = os.readlink(link)
    full = (link.parent / rel).resolve()
    if RELEASES.resolve() not in full.parents or not full.is_dir():
        raise RuntimeError("Refusing symlink outside release directory")
    return full

def switch(link, target):
    # target must be a release under RELEASES, never arbitrary user path
    if target.parent.resolve() != RELEASES.resolve() or not target.is_dir():
        raise RuntimeError("Invalid target release")
    temp = BASE / (".link-" + str(os.getpid()))
    try:
        temp.symlink_to(target, target_is_directory=True)
        os.replace(temp, link)
    finally:
        temp.unlink(missing_ok=True)

def copy_static(src, dest):
    if not src.is_dir() or src.is_symlink():
        raise RuntimeError("Repository must contain a real preview/ directory")
    total = count = 0
    for root, dirs, files in os.walk(src, followlinks=False):
        rootpath = Path(root)
        for directory in dirs:
            if (rootpath / directory).is_symlink():
                raise RuntimeError("Symbolic links are forbidden")
        for name in files:
            p = rootpath / name
            if not p.is_file() or p.is_symlink():
                raise RuntimeError("Non-regular files are forbidden")
            count += 1
            total += p.stat().st_size
            if count > MAX_FILES or total > MAX_TOTAL:
                raise RuntimeError("Static asset size/count limit exceeded")
            out = dest / p.relative_to(src)
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, out)
            out.chmod(0o640)
    if not (dest / "index.html").is_file():
        raise RuntimeError("preview/index.html is required")
    return count, total

def deploy(sha):
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError("Invalid Git SHA")
    dest = RELEASES / sha
    if not dest.exists():
        with tempfile.TemporaryDirectory(prefix="eduapp-src-", dir=BASE) as tmp:
            src = Path(tmp) / "repo"
            subprocess.run(["/usr/bin/git", "clone", "--depth", "1", "--single-branch", "--branch", "main", REPO, str(src)], check=True, timeout=90, stdout=subprocess.DEVNULL)
            head = subprocess.check_output(["/usr/bin/git", "-C", str(src), "rev-parse", "HEAD"], text=True).strip()
            if head != sha:
                raise RuntimeError("Requested commit is not current origin/main HEAD")
            staged = Path(tmp) / "release"
            staged.mkdir()
            count, total = copy_static(src / "preview", staged)
            staged.rename(dest)
            log(f"prepared release {sha} ({count} files, {total} bytes)")
    old = link_target(CURRENT)
    if old == dest:
        print("Already deployed", sha)
        return
    if old is not None:
        switch(PREVIOUS, old)
    switch(CURRENT, dest)
    log(f"deployed release {sha}")
    print("Deployed preview release", sha)

def rollback():
    old = link_target(PREVIOUS)
    if old is None:
        raise RuntimeError("No previous release available")
    current = link_target(CURRENT)
    switch(CURRENT, old)
    if current is not None:
        switch(PREVIOUS, current)
    log(f"rolled back to {old.name}")
    print("Rollback complete:", old.name)

def main():
    import sys
    if len(sys.argv) not in (2, 3):
        raise SystemExit("Usage: deploy <40-char-sha> | rollback")
    BASE.mkdir(exist_ok=True)
    with (BASE / ".ops.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            if sys.argv[1] == "rollback" and len(sys.argv) == 2:
                rollback()
            elif sys.argv[1] == "deploy" and len(sys.argv) == 3:
                deploy(sys.argv[2])
            else:
                raise RuntimeError("Unknown operation")
        except Exception as e:
            log(f"FAILED {sys.argv[1]}: {str(e)[:240]}")
            raise

if __name__ == "__main__":
    main()
