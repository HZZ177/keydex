from __future__ import annotations

import argparse
import os

import uvicorn

from backend.app.core.env import env_name


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-dir", default=None)
    args = parser.parse_args()
    if args.data_dir:
        os.environ[env_name("DATA_DIR")] = args.data_dir

    from backend.app.main import app

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level="info",
        access_log=False,
        log_config=None,
    )


if __name__ == "__main__":
    main()
