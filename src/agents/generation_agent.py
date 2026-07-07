# Generation Agent for proposing initial hypotheses

import logging
from typing import List, Dict, Any

from .base_agent import BaseAgent

class GenerationAgent(BaseAgent):
    """Agent responsible for generating initial hypotheses based on the research goal."""
    
    def __init__(self, model=None, temperature=None):
        """Initialize the Generation Agent.
        
        Args:
            model: Optional model override
            temperature: Optional temperature override
        """
        system_prompt = """
        You are a Generation Agent in an AI Co-Scientist system, responsible for proposing novel areas of interest and potential research directions based on the user's research goal. You have expertise across multiple scientific disciplines at a PhD level.

        Your role is to:
        1. Suggest diverse, novel, and relevant areas of interest or research directions that the user might not have considered, based on the research goal provided.
        2. Leverage your broad knowledge to surface surprising or emerging topics, interdisciplinary connections, and new angles for investigation.
        3. For each area of interest, generate multiple specific research questions that could guide further investigation into new aspects of the topic.
        4. Ensure each area of interest is clearly described and the research questions are actionable and thought-provoking.

        Your output should include:
        - A list of distinct areas of interest (not just hypotheses), each with:
            - A clear description of the area or direction
            - 2-3 research questions that could be explored within this area

        Remember:
        - Areas of interest should be relevant to the research goal, but can be tangential or surprising if they open up new avenues for discovery.
        - Research questions should be specific, actionable, and designed to inspire further investigation.
        - Avoid repeating the research goal verbatim; instead, expand on it with new perspectives.
        """
        
        super().__init__(
            name="Generation",
            system_prompt=system_prompt,
            model=model,
            temperature=temperature if temperature is not None else 0.7  # Higher temperature for creativity
        )
        
        self.logger = logging.getLogger("agent.generation")
    
    def generate_hypotheses(self, research_goal: str, count: int = 5) -> List[Dict[str, Any]]:
        """Generate initial hypotheses based on the research goal.
        
        Args:
            research_goal: The research goal or question
            count: Number of hypotheses to generate
            
        Returns:
            A list of hypothesis dictionaries
        """
        self.logger.info(f"Generating {count} hypotheses for research goal: {research_goal}")
        return self.process(research_goal)
    
    def process(self, research_goal: str) -> list:
        """Generate areas of interest and research questions based on the research goal."""
        self.logger.info(f"Generating hypotheses for research goal: {research_goal}")
        
        prompt = f"""
        RESEARCH GOAL: {research_goal}
        
        Based on the research goal above, suggest at least 3-5 distinct AREAS OF INTEREST or potential research directions that the user might not have considered. For each area of interest:
        - Provide a clear description of the area or direction
        - Generate 2-3 specific research questions that could be explored within this area
        
        Format your response as a structured list, with each area of interest clearly separated, and each research question listed under its area.
        Be creative, leverage your broad knowledge, and focus on novelty and relevance.
        """
        
        response = self.get_response(prompt)
        self.logger.info(f"Raw LLM response: {response}")
        
        # Use the new robust parser
        return self._parse_areas_of_interest(response)

    def _parse_areas_of_interest(self, response: str) -> list:
        """
        Robustly parse LLM output for areas of interest and their research questions.
        Handles numbered/bulleted lists, headings, and flexible formats.
        Returns a list of dicts: { 'statement': ..., 'research_questions': [...] }
        """
        import re
        areas = []
        current_area = None
        current_questions = []
        lines = response.splitlines()
        area_pattern = re.compile(r"^(?:\d+\.|[-*])?\s*(Area of Interest|Area|Direction|Topic)?\s*:?\s*(.+)$", re.IGNORECASE)
        question_pattern = re.compile(r"^(?:[-*]|\d+\.|\d+\))\s*(What|How|Why|Which|Could|Is|Are|Does|Do|Can|To what extent|In what ways|Where|When|Who|Should|Would|Might|Will|Has|Have|Did|Does)\b.+", re.IGNORECASE)
        
        for line in lines:
            line = line.strip()
            if not line:
                continue
            # Detect area of interest
            if area_pattern.match(line) and not question_pattern.match(line):
                # Save previous area
                if current_area:
                    areas.append({
                        'statement': current_area,
                        'research_questions': current_questions
                    })
                # Start new area
                match = area_pattern.match(line)
                area_text = match.group(2).strip()
                current_area = area_text
                current_questions = []
            # Detect research question
            elif question_pattern.match(line):
                current_questions.append(line)
            # Sometimes questions are indented or bulleted without a clear marker
            elif line.endswith('?') and len(line) < 200:
                current_questions.append(line)
        # Add last area
        if current_area:
            areas.append({
                'statement': current_area,
                'research_questions': current_questions
            })
        return areas
