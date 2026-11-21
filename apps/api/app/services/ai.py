"""Bring-your-own-key AI provider abstraction (OpenAI, Anthropic, Gemini, OpenRouter, any OpenAI-compatible)."""

import httpx

DEFAULT_MODELS = {
    "openai": "gpt-4o-mini",
    "anthropic": "claude-sonnet-5-5",
    "gemini": "gemini-2.5-flash",
    "openrouter": "openai/gpt-4o-mini",
    "custom": "",
}

OPENAI_COMPATIBLE_BASES = {
    "openai": "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
}


async def complete(provider: str, api_key: str, prompt: str, *, model: str | None = None,
                   base_url: str | None = None, system: str = "", max_tokens: int = 800) -> str:
    model = model or DEFAULT_MODELS.get(provider, "")
    async with httpx.AsyncClient(timeout=60) as client:
        if provider == "anthropic":
            r = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
                json={"model": model, "max_tokens": max_tokens,
                      "messages": [{"role": "user", "content": prompt}], **({"system": system} if system else {})},
            )
            r.raise_for_status()
            return "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text")

        if provider == "gemini":
            r = await client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                params={"key": api_key},
                json={
                    "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                    "generationConfig": {"maxOutputTokens": max_tokens},
                    **({"systemInstruction": {"parts": [{"text": system}]}} if system else {}),
                },
            )
            r.raise_for_status()
            parts = r.json().get("candidates", [{}])[0].get("content", {}).get("parts", [])
            return "".join(p.get("text", "") for p in parts)

        base = (base_url or OPENAI_COMPATIBLE_BASES.get(provider, "")).rstrip("/")
        if not base:
            raise ValueError("A base URL is required for custom providers")
        messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
        r = await client.post(
            f"{base}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"model": model, "messages": messages, "max_tokens": max_tokens},
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"] or ""


async def test_apollo(api_key: str) -> tuple[bool, str]:
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get("https://api.apollo.io/v1/auth/health", headers={"X-Api-Key": api_key})
    if r.status_code == 200 and r.json().get("is_logged_in", True):
        return True, "Connected to Apollo"
    return False, f"Apollo returned {r.status_code}"
