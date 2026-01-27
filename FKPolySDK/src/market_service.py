import requests
import json
import traceback

class MarketService:
    @staticmethod
    def get_market_by_slug(slug: str):
        try:
            r = requests.get("https://gamma-api.polymarket.com/markets", params={"slug": slug}, timeout=20)
            if r.status_code != 200: return None
            arr = r.json()
            if not isinstance(arr, list) or len(arr) == 0: return None
            return arr[0]
        except:
            return None

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
