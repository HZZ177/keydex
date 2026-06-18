from fastapi import Request

from backend.app.storage import StorageRepositories


def get_repositories(request: Request) -> StorageRepositories:
    return request.app.state.repositories
