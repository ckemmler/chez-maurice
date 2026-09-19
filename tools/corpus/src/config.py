"""Configuration loading for akita-corpus."""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml
from pydantic import BaseModel, Field, field_validator, ValidationError
from dotenv import load_dotenv

_LOG = logging.getLogger(__name__)


def _load_repo_env() -> None:
    start = Path(__file__).resolve().parent
    for directory in [start, *start.parents]:
        env_file = directory / ".env"
        if env_file.exists():
            load_dotenv(env_file, override=False)
            break


_load_repo_env()


class QdrantConfig(BaseModel):
    host: str = "localhost"
    port: int = 6333
    collection: str = "akita-corpus"
    url: Optional[str] = None
    api_key: Optional[str] = None


class StoreConfig(BaseModel):
    """Selects the vector store backend. Defaults to Qdrant for back-compat."""
    backend: str = "qdrant"
    # sqlite-vec: directory holding the per-member <member>.db files.
    path: Optional[Path] = None

    @field_validator("path", mode="before")
    @classmethod
    def _coerce_path(cls, value: Any) -> Any:
        return Path(str(value)) if value is not None else None


class EmbeddingConfig(BaseModel):
    provider: str
    model: str
    api_key: Optional[str] = None
    host: Optional[str] = None
    base_url: Optional[str] = None
    batch_size: int = 100
    max_retries: int = 3
    vector_size: int = 1536
    # Ask the provider for this many dimensions (the OpenAI `dimensions`
    # parameter). Only a matryoshka-trained model — Qwen3-Embedding, whose
    # leading dimensions are an embedding on their own — can honour it, and
    # for those families the embedder already asks for vector_size without
    # being told; this is the explicit override, and it must equal vector_size
    # since one number sizes the store and the request alike. Unset (or empty
    # from the environment) means "let the embedder decide".
    dimensions: Optional[int] = None
    # What goes in front of a query, and in front of a document, before the
    # model sees it. None (the default) takes the model family's own convention
    # from embedder.py; an explicit string — including "" — overrides it.
    query_prefix: Optional[str] = None
    document_prefix: Optional[str] = None

    @field_validator("dimensions", mode="before")
    @classmethod
    def _blank_is_none(cls, value: Any) -> Any:
        return None if value in ("", None) else value

    @field_validator("dimensions")
    @classmethod
    def _dimensions_match(cls, value: Optional[int], info: Any) -> Optional[int]:
        size = info.data.get("vector_size")
        if value is not None and size is not None and value != size:
            raise ValueError(
                f"embedding.dimensions ({value}) must equal embedding.vector_size ({size}): "
                "the store is sized by vector_size, the request by dimensions, and they cannot differ"
            )
        return value


class ChunkingConfig(BaseModel):
    method: str = "paragraph"
    max_tokens: int = 512
    overlap_tokens: int = 0


class MetadataConfig(BaseModel):
    source_type: str
    extract_from_path: Dict[str, str] = Field(default_factory=dict)
    extract_from_frontmatter: bool = False


class SourceConfig(BaseModel):
    path: Path
    pattern: str = "**/*"
    # Glob patterns, matched against the source-relative path, that this source
    # must NOT claim. Needed because pathlib globs have no negation: the garden
    # tree nests notes, fiches and published cards at the same depth, so the
    # cards source can only be expressed as "everything at that depth, except".
    exclude: List[str] = Field(default_factory=list)
    recursive: bool = True
    chunking: ChunkingConfig
    metadata: MetadataConfig
    # Optional path-extractor expression (same grammar as metadata.extract_from_path)
    # that derives the owning member from a file's path, so per-member sources
    # (e.g. garden notes under web/gardens/<member>/...) route to that member's DB.
    # When unset, indexing falls back to member_id_var / the shared _default.db pool.
    member_from_path: Optional[str] = None
    # How to turn the member_from_path value into a vector-store member id.
    # "garden_username": treat it as a maurice.db users.username and resolve to the
    # user's UUID (the key the per-member DBs are named by). Unset: use it verbatim.
    member_lookup: Optional[str] = None

    @field_validator("path", mode="before")
    @classmethod
    def _coerce_path(cls, value: Any) -> Path:
        return Path(str(value))


class WatcherConfig(BaseModel):
    debounce_seconds: float = 2.0
    ignore_patterns: List[str] = Field(default_factory=list)


class CorpusConfig(BaseModel):
    qdrant: QdrantConfig = Field(default_factory=QdrantConfig)
    store: StoreConfig = Field(default_factory=StoreConfig)
    embedding: EmbeddingConfig
    watcher: WatcherConfig
    sources: Dict[str, SourceConfig]

    def resolve_paths(self, root: Path) -> None:
        missing: list[str] = []
        for name, source in list(self.sources.items()):
            if not source.path.is_absolute():
                source.path = (root / source.path).resolve()
            if not source.path.exists():
                _LOG.warning("Source '%s' path does not exist: %s — skipping", name, source.path)
                missing.append(name)
        for name in missing:
            del self.sources[name]

    @property
    def source_names(self) -> List[str]:
        return list(self.sources.keys())


_DEFAULT_ENV_PATTERN = re.compile(r"\$\{([^:{}]+):-([^}]*)\}")


def _expand_string(value: str) -> str:
    def replacer(match: re.Match[str]) -> str:
        var, default = match.group(1), match.group(2)
        return os.environ.get(var, default)

    value = _DEFAULT_ENV_PATTERN.sub(replacer, value)
    return os.path.expandvars(value)


def _expand_env(value: Any) -> Any:
    if isinstance(value, str):
        return _expand_string(value)
    if isinstance(value, list):
        return [_expand_env(v) for v in value]
    if isinstance(value, dict):
        return {k: _expand_env(v) for k, v in value.items()}
    return value


def load_config(path: Path, *, repo_root: Optional[Path] = None) -> CorpusConfig:
    if not path.exists():
        raise FileNotFoundError(f"Config file not found: {path}")
    data = yaml.safe_load(path.read_text())
    data = _expand_env(data)
    try:
        config = CorpusConfig.model_validate(data)
    except ValidationError as exc:
        raise ValueError(f"Invalid corpus config: {exc}") from exc
    base_root = repo_root or path.parent.parent
    config.resolve_paths(base_root)
    return config


__all__ = ["CorpusConfig", "load_config"]
