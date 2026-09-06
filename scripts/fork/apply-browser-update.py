#!/usr/bin/env python3
"""Apply this prepared local release. --check validates it without quitting T3."""

import argparse
import hashlib
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time

VERSION = "0.0.38-panes.1788763200000.browser"
ARCHIVE = Path(__file__).resolve().parents[2] / "release/browser-approved" / f"T3-Code-{VERSION}-arm64.zip"
SHA256 = "3d6494fc2361800c3e8cad2c15616feafe88e372e2db43451d409158ec941528"
APP = Path("/Applications/T3 Code (Alpha).app")
BUNDLE_ID = "com.t3tools.t3code"
SIGNING_IDENTITY = "787B7C3C272412067373968CD4DC90BEACA15149"
BACKUP = APP.with_name("T3 Code (Alpha).before-approved-browser-update.app")


def metadata(app):
    with (app / "Contents/Info.plist").open("rb") as file:
        return plistlib.load(file)


def app_processes():
    output = subprocess.check_output(
        ["/bin/ps", "-axo", "pid=,comm="], text=True
    )
    result = []
    for line in output.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2 and fields[1].startswith(str(APP) + "/Contents/"):
            result.append(int(fields[0]))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if sys.platform != "darwin" or os.uname().machine != "arm64":
        raise RuntimeError("This release requires an Apple Silicon Mac.")
    if os.geteuid() == 0:
        raise RuntimeError("Run this as your normal Mac user, without sudo.")
    digest = hashlib.sha256()
    with ARCHIVE.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != SHA256:
        raise RuntimeError("Release ZIP checksum mismatch. The app has not been touched.")
    if APP.is_symlink() or metadata(APP)["CFBundleIdentifier"] != BUNDLE_ID:
        raise RuntimeError("Installed application path or identity does not match.")
    current = metadata(APP)["CFBundleShortVersionString"]
    if current == VERSION:
        print(f"Already installed: {VERSION}")
        return
    if not args.check and BACKUP.exists():
        raise RuntimeError(f"Backup already exists; preserve or move it first: {BACKUP}")

    # Fully validate the extracted bundle before asking the running app to quit.
    # For installation, staging beside the destination keeps the renames local.
    stage = Path(tempfile.mkdtemp(
        prefix=".t3-browser-update-", dir=None if args.check else APP.parent
    ))
    try:
        subprocess.run(["/usr/bin/ditto", "-x", "-k", str(ARCHIVE), str(stage)], check=True)
        candidate = stage / APP.name
        info = metadata(candidate)
        if (info["CFBundleIdentifier"] != BUNDLE_ID or
                info["CFBundleShortVersionString"] != VERSION):
            raise RuntimeError("Prepared application identity/version mismatch.")
        # Use the same Apple Development identity on every local update so
        # macOS permissions can survive changes to the executable.
        subprocess.run(
            ["/usr/bin/codesign", "--force", "--deep", "--sign", SIGNING_IDENTITY,
             "--preserve-metadata=entitlements,flags,runtime",
             "--timestamp=none", str(candidate)],
            check=True,
        )
        subprocess.run(
            ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(candidate)],
            check=True,
        )
        print(f"Validated update: {current} -> {VERSION}", flush=True)
        if args.check:
            print("Check complete. The running app and installed bundle were not changed.")
            return

        print("Applying update now. Local agent work and terminals must be ready to stop.", flush=True)
        print(f"Backup: {BACKUP}", flush=True)
        if app_processes():
            # Normal application quit. Never force-kill a server or agent.
            subprocess.run(
                ["/usr/bin/osascript", "-e",
                 f'tell application "{APP}" to quit'],
                check=True, timeout=120,
            )
        deadline = time.monotonic() + 120
        while app_processes():
            if time.monotonic() >= deadline:
                raise RuntimeError("T3 still has running processes. Installation cancelled; no force quit.")
            time.sleep(1)
        if BACKUP.exists():
            raise RuntimeError(f"Backup appeared during staging; installation cancelled: {BACKUP}")
        APP.rename(BACKUP)
        try:
            candidate.rename(APP)
        except BaseException:
            BACKUP.rename(APP)
            subprocess.run(["/usr/bin/open", str(APP)], check=False)
            raise
        subprocess.run(["/usr/bin/open", str(APP)], check=True)
        deadline = time.monotonic() + 30
        while not app_processes():
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Bundle installed but launch was not confirmed. Backup: {BACKUP}")
            time.sleep(1)
        print(f"Installed and launched {metadata(APP)['CFBundleShortVersionString']}.")
        print("Confirm your panes and threads have reopened before deleting the backup.")
        print("T3 settings and user data were not modified by this script.")
    finally:
        shutil.rmtree(stage)


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(f"Update stopped: {error}", file=sys.stderr)
        sys.exit(1)
