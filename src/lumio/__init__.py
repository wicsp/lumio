import asyncio
from .cli import run_cli

def main() -> None:
    """Main entry point for the Lumio application."""
    try:
        asyncio.run(run_cli())
    except KeyboardInterrupt:
        print("\nGoodbye!")
    except Exception as e:
        print(f"An error occurred: {e}")
