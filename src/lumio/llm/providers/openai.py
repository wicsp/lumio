
import openai
from typing import Dict, Any, List, Optional
from ..base import LLMProvider

class OpenAIProvider(LLMProvider):
    """OpenAI-compatible API provider."""
    
    def __init__(self, api_key: str, base_url: str, model: str = "gpt-3.5-turbo"):
        self.client = openai.AsyncOpenAI(
            api_key=api_key,
            base_url=base_url
        )
        self.model = model
    
    async def generate(self, 
                      messages: List[Dict[str, str]], 
                      temperature: float = 0.7,
                      max_tokens: Optional[int] = None) -> str:
        """Generate text from the LLM."""
        try:
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens
            )
            return response.choices[0].message.content
        except Exception as e:
            print(f"Error calling LLM API: {e}")
            return "I encountered an error while processing your request."

