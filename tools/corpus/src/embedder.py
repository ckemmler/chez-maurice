"""Embedding providers abstraction.

One door for every vector the corpus makes, and two things it knows that the
callers should not have to:

- **What a model expects in front of the text.** Retrieval models are trained
  asymmetrically: a query and a document get different prefixes, and a model
  fed bare text answers with a quieter, blurrier space. nomic wants
  `search_query:` / `search_document:`; Qwen3-Embedding wants an instruction
  line on the query and nothing on the document; BGE-multilingual-gemma2 the
  same with its own markers. The index built before September 2026 sent bare
  text to nomic — it worked, and it was worse than it needed to be. The family
  table below is the default; `embedding.query_prefix` / `document_prefix` in
  the config override it (an empty string means "none", explicitly).

- **How wide the vector is.** Matryoshka-trained models (Qwen3-Embedding, nomic
  v2) can be asked for fewer dimensions than their native width, and the
  prefix of the vector stays a valid embedding on its own. `embedding.dimensions`
  asks the provider for exactly that many — Ollama and Scaleway both honour the
  OpenAI `dimensions` parameter — and the store is sized by the same number.
  A provider that answers with a different width is refused here rather than
  discovered later as a sqlite-vec insert error with no model name in it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, List, Literal, Optional

from openai import AsyncOpenAI

from .config import EmbeddingConfig

Kind = Literal["document", "query"]

# (model-name pattern, query prefix, document prefix, matryoshka), first match
# wins. Instruction texts are the ones each model card recommends for
# retrieval. `matryoshka` says the family can be asked for fewer dimensions
# than its native width; for those the request always carries
# `dimensions=vector_size`, so one number in the config sizes both the store
# and the vectors (Qwen3-Embedding 0.6B/4B/8B at 1024 are the same shape of
# store, whichever size a household runs).
_RETRIEVAL_TASK = "Given a web search query, retrieve relevant passages that answer the query"
_FAMILIES: list[tuple[re.Pattern[str], str, str, bool]] = [
    (re.compile(r"qwen3-embedding", re.I), f"Instruct: {_RETRIEVAL_TASK}\nQuery: ", "", True),
    (re.compile(r"nomic-embed", re.I), "search_query: ", "search_document: ", False),
    (re.compile(r"bge-multilingual-gemma2", re.I), f"<instruct>{_RETRIEVAL_TASK}.\n<query>", "", False),
]


def family_prefixes(model: str) -> tuple[str, str]:
    """(query prefix, document prefix) a model family expects; empty for an unknown one."""
    for pattern, query, document, _ in _FAMILIES:
        if pattern.search(model or ""):
            return query, document
    return "", ""


def family_matryoshka(model: str) -> bool:
    return any(mrl for pattern, _, _, mrl in _FAMILIES if pattern.search(model or ""))


@dataclass
class EmbeddingResult:
    vectors: List[List[float]]
    model: str


class Embedder:
    def __init__(self, config: EmbeddingConfig) -> None:
        self.config = config
        if config.provider == "ollama":
            base_url = config.base_url or "http://localhost:11434/v1"
            self.client = AsyncOpenAI(base_url=base_url, api_key="ollama")
            self._tiktoken_encoder = None
        elif config.provider == "openai":
            # Any OpenAI-shaped endpoint: OpenAI itself, or Scaleway's Generative
            # APIs with a base_url. Both take the same `dimensions` parameter.
            self.client = AsyncOpenAI(api_key=config.api_key, base_url=config.base_url or None)
            import tiktoken
            self._tiktoken_encoder = tiktoken.get_encoding("cl100k_base")
        else:
            raise NotImplementedError(f"Unsupported embedding provider: {config.provider}")
        default_query, default_document = family_prefixes(config.model)
        self.query_prefix = default_query if config.query_prefix is None else config.query_prefix
        self.document_prefix = default_document if config.document_prefix is None else config.document_prefix
        # What the request asks for: an explicit `dimensions`, else the store's
        # width for a matryoshka family, else nothing (the native width, which
        # vector_size then has to be).
        self.dimensions: Optional[int] = config.dimensions or (
            config.vector_size if family_matryoshka(config.model) else None
        )

    def count_tokens(self, text: str) -> int:
        if self._tiktoken_encoder is not None:
            return len(self._tiktoken_encoder.encode(text))
        # Rough estimator for non-OpenAI models
        return len(text) // 4

    def prefixed(self, text: str, kind: Kind) -> str:
        return (self.query_prefix if kind == "query" else self.document_prefix) + text

    async def embed_batch(self, texts: Iterable[str], *, kind: Kind = "document") -> EmbeddingResult:
        """Embed texts as documents (the default: everything that is indexed) or
        as queries (what a search sends). Blank strings are dropped, so the
        caller's chunks and the vectors line up only if the caller dropped them
        too — processor.py does."""
        cleaned = [t.strip() for t in texts if t.strip()]
        if not cleaned:
            return EmbeddingResult(vectors=[], model=self.config.model)
        kwargs: dict = {"model": self.config.model, "input": [self.prefixed(t, kind) for t in cleaned]}
        if self.dimensions:
            kwargs["dimensions"] = self.dimensions
        response = await self.client.embeddings.create(**kwargs)
        vectors = [item.embedding for item in response.data]
        expected = self.config.vector_size
        if vectors and expected and len(vectors[0]) != expected:
            raise RuntimeError(
                f"{self.config.model} answered {len(vectors[0])}-dimensional vectors; the store is "
                f"sized for {expected}. Either the provider ignores `dimensions` (the model is not "
                f"matryoshka-trained) or embedding.vector_size is wrong for this model."
            )
        # The configured name, not the provider's echo of it: this is what the
        # store pins and what it checks against the config at every open, so the
        # two have to be the same string.
        return EmbeddingResult(vectors=vectors, model=self.config.model)

    async def embed_query(self, text: str) -> Optional[List[float]]:
        result = await self.embed_batch([text], kind="query")
        return result.vectors[0] if result.vectors else None
