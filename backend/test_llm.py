import httpx
import os
from dotenv import load_dotenv

load_dotenv()

api_key = os.getenv("OPENROUTER_API_KEY")

response = httpx.post(
    "https://openrouter.ai/api/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    },
    json={
        "model": "liquid/lfm-2.5-2.6b:free",
        "messages": [
            {"role": "user", "content": "Say hello in one sentence."}
        ]
    }
)

data = response.json()
content = data["choices"][0]["message"]["content"]
print(content)