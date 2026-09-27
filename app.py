import os
from pathlib import Path
import shutil
import subprocess
import sys


SERVER_DIR = Path(__file__).resolve().parent / "server"


def main():
    npm = "npm.cmd" if os.name == "nt" else "npm"
    if shutil.which(npm) is None:
        print("npm was not found. Install Node.js and npm, then try again.", file=sys.stderr)
        return 1

    if not (SERVER_DIR / "node_modules").is_dir():
        print(
            "Backend dependencies are missing. Install them with: npm install --prefix server",
            file=sys.stderr,
        )
        return 1

    print("Starting the agent server. Press Ctrl+C to stop it.", flush=True)
    try:
        return subprocess.call([npm, "start"], cwd=SERVER_DIR)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())