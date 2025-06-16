
from .providers.openai import OpenAIProvider

# Default configuration
DEFAULT_API_KEY = "sk-J9dxpKWIrwolEQhTACDZTNeWDpzvoQ9CNTaBEh8b0FzvNugY"
DEFAULT_API_URL = "https://api.voct.dev/v1"
DEFAULT_MODEL = "deepseek-ai/DeepSeek-V3-0324"

def create_llm(
    api_key: str = DEFAULT_API_KEY,
    base_url: str = DEFAULT_API_URL,
    model: str = DEFAULT_MODEL
):
    """Create an LLM provider instance."""
    return OpenAIProvider(
        api_key=api_key,
        base_url=base_url,
        model=model
    )

