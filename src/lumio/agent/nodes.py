from ..llm import create_llm
from .state import AgentState

async def process_user_input(state: AgentState) -> AgentState:
    """Process user input and generate a response."""
    llm = create_llm()
    
    try:
        response = await llm.generate(
            messages=state.get_messages(),
            temperature=0.7
        )
        state.add_assistant_message(response)
    except Exception as e:
        print(f"Error in process_user_input: {e}")
        state.add_assistant_message("I encountered an error. Please try again.")
    
    return state