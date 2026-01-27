import requests
import json
import traceback
from typing import Dict, Any, List, Optional
from src.api_clients import GammaApiClient

class MarketService:
    @staticmethod
    def get_market_by_slug(slug: str):
        try:
            markets = GammaApiClient.get_markets(slug=slug, limit=1)
            if markets and len(markets) > 0:
                return markets[0]
        except:
            pass
        return None

    @staticmethod
    def get_market_kline(market_id: str, interval: str = "1h") -> List[Dict[str, Any]]:
        """
        Fetches K-line (OHLCV) data for a market.
        Note: Gamma API might need a specific endpoint for history, usually /history or similar.
        Simulating with basic price history if specific endpoint unknown in docs.
        """
        # Placeholder for real history implementation
        return []

    @staticmethod
    def get_market_signals(market_id: str) -> Dict[str, Any]:
        """
        Analyzes market for signals (e.g. Volume spike, Price crossover).
        """
        return {"signal": "NEUTRAL", "confidence": 0.0}

    @staticmethod
    def resolve_token_id(slug: str, outcome_index=None, outcome=None):
        m = MarketService.get_market_by_slug(slug)
        if not m: return None
        tokens = m.get("clobTokenIds")
        outs = m.get("outcomes")
        idx = None
        
        if isinstance(outcome_index, int):
            idx = outcome_index
        else:
            if isinstance(outs, str): outs = json.loads(outs)
            if isinstance(outs, list) and outcome is not None:
                for i, o in enumerate(outs):
                    if str(o).strip().lower() == str(outcome).strip().lower():
                        idx = i
                        break
        
        if idx is None: return None
        if isinstance(tokens, str): tokens = json.loads(tokens)
        if not isinstance(tokens, list) or idx >= len(tokens): return None
        return tokens[idx]
