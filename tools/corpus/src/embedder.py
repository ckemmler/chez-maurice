"""Embedding providers abstraction."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List

from openai import AsyncOpenAI

from .config import EmbeddingConfig


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
            self.client = AsyncOpenAI(api_key=config.api_key)
            import tiktoken
            self._tiktoken_encoder = tiktoken.get_encoding("cl100k_base")
        else:
            raise NotImplementedError(f"Unsupported embedding provider: {config.provider}")

    def count_tokens(self, text: str) -> int:
        if self._tiktoken_encoder is not None:
            return len(self._tiktoken_encoder.encode(text))
        # Rough estimator for non-OpenAI models
        return len(text) // 4

    async def embed_batch(self, texts: Iterable[str]) -> EmbeddingResult:
        cleaned = [t.strip() for t in texts if t.strip()]
        if not cleaned:
            return EmbeddingResult(vectors=[], model=self.config.model)
        response = await self.client.embeddings.create(
            model=self.config.model,
            input=cleaned,
        )
        vectors = [item.embedding for item in response.data]
        return EmbeddingResult(vectors=vectors, model=response.model)
