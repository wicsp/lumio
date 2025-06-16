from typing import List, Dict, Any
from pydantic import BaseModel, Field
from langgraph.graph.message import add_messages

class AgentState(BaseModel):
    """State for the agent conversation."""
    messages: List[Dict[str, str]] = Field(default_factory=list)
    
    def add_user_message(self, content: str) -> None:
        """Add a user message to the conversation."""
        self.messages.append({"role": "user", "content": content})
    
    def add_assistant_message(self, content: str) -> None:
        """Add an assistant message to the conversation."""
        self.messages.append({"role": "assistant", "content": content})
    
    def get_messages(self) -> List[Dict[str, str]]:
        """Get all messages in the conversation."""
        # Always include a system message at the beginning
        system_msg = {"role": "system", "content": "You are Lumio, a helpful AI assistant."}
        return [system_msg] + self.messages