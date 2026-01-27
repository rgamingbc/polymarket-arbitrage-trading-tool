import requests
from typing import Dict, Any, List, Optional

class DataApiClient:
    BASE_URL = "https://data-api.polymarket.com"

    @staticmethod
    def get_trades(user: str) -> List[Dict[str, Any]]:
        try:
            r = requests.get(f"{DataApiClient.BASE_URL}/trades", params={"user": user}, timeout=10)
            if r.status_code == 200 and isinstance(r.json(), list):
                return r.json()
            r = requests.get(f"{DataApiClient.BASE_URL}/trades", params={"proxyWallet": user}, timeout=10)
            if r.status_code == 200 and isinstance(r.json(), list):
                return r.json()
        except:
            pass
        return []

    @staticmethod
    def get_activity(user: str, limit: int = 20) -> List[Dict[str, Any]]:
        try:
            r = requests.get(f"{DataApiClient.BASE_URL}/activity", params={"user": user, "limit": limit}, timeout=10)
            if r.status_code == 200 and isinstance(r.json(), list):
                return r.json()
            r = requests.get(f"{DataApiClient.BASE_URL}/activity", params={"proxyWallet": user, "limit": limit}, timeout=10)
            if r.status_code == 200 and isinstance(r.json(), list):
                return r.json()
        except:
            pass
        return []

    @staticmethod
    def get_positions(user: str) -> List[Dict[str, Any]]:
        try:
            r = requests.get(f"{DataApiClient.BASE_URL}/positions", params={"user": user}, timeout=10)
            if r.status_code == 200:
                return r.json()
        except:
            pass
        return []

class GammaApiClient:
    BASE_URL = "https://gamma-api.polymarket.com"

    @staticmethod
    def get_markets(slug: str = None, limit: int = 20) -> List[Dict[str, Any]]:
        try:
            params = {"limit": limit}
            if slug: params["slug"] = slug
            r = requests.get(f"{GammaApiClient.BASE_URL}/markets", params=params, timeout=10)
            if r.status_code == 200:
                return r.json()
        except:
            pass
        return []

    @staticmethod
    def get_market(id: str) -> Optional[Dict[str, Any]]:
        try:
            r = requests.get(f"{GammaApiClient.BASE_URL}/markets/{id}", timeout=10)
            if r.status_code == 200:
                return r.json()
        except:
            pass
        return None
