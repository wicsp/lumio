from langgraph.graph import StateGraph
from .state import AgentState
from .nodes import process_user_input

def create_agent_graph():
    """Create the agent graph."""
    # Create a new graph
    graph = StateGraph(AgentState)
    
    # Add the process_user_input node
    graph.add_node("process_user_input", process_user_input)
    
    # Set the entry point
    graph.set_entry_point("process_user_input")
    
    # Set the exit point
    graph.set_finish_point("process_user_input")
    
    # Compile the graph
    return graph.compile()