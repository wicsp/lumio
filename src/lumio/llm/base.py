
from typing import Dict, Any, List, Optional
from abc import ABC, abstractmethod

class LLMProvider(ABC):
    """Base class for all LLM providers."""
    
    @abstractmethod
    async def generate(self, 
                      messages: List[Dict[str, str]], 
                      temperature: float = 0.7,
                      max_tokens: Optional[int] = None) -> str:
        """Generate text from the LLM."""
        pass

