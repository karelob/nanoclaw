"""
Model-agnostický LLM klient pro finanční analýzy.
Primárně Ollama (citlivá data), fallback na cloud modely.
"""
import json
import os
import requests
from typing import Optional


class LLMClient:
    """
    Model-agnostický klient. Vyměnitelný backend bez změny volající logiky.
    """

    BACKENDS = ['ollama', 'openai', 'gemini']

    def __init__(self, backend: str = 'ollama', model: str = None):
        self.backend = backend
        self.model = model or self._default_model(backend)

    def _default_model(self, backend: str) -> str:
        defaults = {
            'ollama': 'qwen2.5:14b',
            'openai': 'gpt-4o-mini',
            'gemini': 'gemini-2.0-flash',
        }
        return defaults.get(backend, 'qwen2.5:14b')

    def complete(self, prompt: str, system: str = '', max_tokens: int = 4096) -> str:
        """Pošle prompt a vrátí odpověď jako string."""
        if self.backend == 'ollama':
            return self._ollama(prompt, system)
        elif self.backend == 'openai':
            return self._openai(prompt, system, max_tokens)
        elif self.backend == 'gemini':
            return self._gemini(prompt, system)
        else:
            raise ValueError(f"Neznámý backend: {self.backend}")

    def _ollama(self, prompt: str, system: str = '') -> str:
        url = 'http://10.0.10.70:11434/api/generate'
        payload = {
            'model': self.model,
            'prompt': prompt,
            'stream': False,
        }
        if system:
            payload['system'] = system
        r = requests.post(url, json=payload, timeout=120)
        r.raise_for_status()
        return r.json().get('response', '')

    def _openai(self, prompt: str, system: str = '', max_tokens: int = 4096) -> str:
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from paths import load_env_var
        try:
            api_key = load_env_var('OPENAI_API_KEY')
        except RuntimeError:
            api_key = None
        if not api_key:
            raise ValueError("OPENAI_API_KEY nenalezen")

        import urllib.request
        messages = []
        if system:
            messages.append({'role': 'system', 'content': system})
        messages.append({'role': 'user', 'content': prompt})

        data = json.dumps({
            'model': self.model,
            'messages': messages,
            'max_tokens': max_tokens,
        }).encode()
        req = urllib.request.Request(
            'https://api.openai.com/v1/chat/completions',
            data=data,
            headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
        return result['choices'][0]['message']['content']

    def _gemini(self, prompt: str, system: str = '') -> str:
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from paths import load_env_var
        try:
            api_key = load_env_var('GOOGLE_AI_API_KEY')
        except RuntimeError:
            api_key = None
        if not api_key:
            raise ValueError("GOOGLE_AI_API_KEY nenalezen")

        full_prompt = f"{system}\n\n{prompt}" if system else prompt
        import urllib.request
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent?key={api_key}"
        data = json.dumps({'contents': [{'parts': [{'text': full_prompt}]}]}).encode()
        req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
        return result['candidates'][0]['content']['parts'][0]['text']


# Finanční systémový prompt (české účetnictví)
FINANCE_SYSTEM_PROMPT = """Jsi expertní finanční asistent pro české firmy.
Znáš české právní předpisy:
- Zákon o účetnictví č. 563/1991 Sb.
- Zákon o DPH č. 235/2004 Sb. (sazby: 21%, 12%, 0%)
- Zákon o daních z příjmů č. 586/1992 Sb. (DPPO 21%, od 2024 19% pro malé firmy)
- DPFO: sazby 15% (základ do 36násobku průměrné mzdy), 23% nad limit

Pracuješ s daty firem: Baker Estates (nemovitosti), Pinehill (consulting),
PineHouse (holding), PineInvest (investice), PineAir (letectví, prodáno 2024).

Odpovídej vždy v češtině. Buď přesný, stručný, uváděj čísla.
Pokud si nejsi jistý, řekni to. Nikdy nevymýšlej data."""
