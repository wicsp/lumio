import asyncio
from rich.console import Console
from rich.markdown import Markdown
from .agent.graph import create_agent_graph
from .agent.state import AgentState

console = Console()

async def run_cli():
    """Run the CLI interface."""
    console.print("[bold blue]Welcome to Lumio![/bold blue]")
    console.print("Type 'exit' or 'quit' to end the conversation.\n")
    
    # Create the agent graph
    agent = create_agent_graph()
    state = AgentState()
    
    while True:
        # Get user input
        user_input = console.input("[bold green]You:[/bold green] ")
        
        # Check if the user wants to exit
        if user_input.lower() in ["exit", "quit"]:
            console.print("\n[bold blue]Goodbye![/bold blue]")
            break
        
        if user_input.lower() == "export":
            try:
                # display(Image(agent.get_graph().draw_mermaid_png()))
                console.print("Exported graph to graph.png")
                agent.get_graph().draw_mermaid_png(output_file_path = "./graph.png")
                break
            except Exception as e:
                console.print(f"Error exporting graph: {e}")
                # This requires some extra dependencies and is optional
                break
        
        # Add the user message to the state
        state.add_user_message(user_input)
        
        # Process the user input
        with console.status("[bold yellow]Thinking...[/bold yellow]"):
            result = await agent.ainvoke(state)

        # Update state with the result
        if hasattr(result, 'messages'):
            state = result
        else:
            # Handle case where result is a dict
            state.messages = result.get('messages', state.messages)

        # Display the assistant's response
        if state.messages:
            assistant_message = state.messages[-1]["content"]
            console.print("[bold purple]Lumio:[/bold purple]")
            console.print(Markdown(assistant_message))
            console.print()