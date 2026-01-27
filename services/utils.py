import time
from functools import wraps
import threading

class RateLimiter:
    def __init__(self, limit=5, window=1):
        self.limit = limit
        self.window = window
        self.calls = []
        self.lock = threading.Lock()

    def allow(self):
        with self.lock:
            now = time.time()
            self.calls = [t for t in self.calls if t > now - self.window]
            if len(self.calls) >= self.limit:
                return False
            self.calls.append(now)
            return True

api_limiter = RateLimiter(limit=10, window=1)

def rate_limit(limiter=api_limiter):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            if not limiter.allow():
                print(f"Rate limit hit for {func.__name__}")
                return None # Or raise exception
            return func(*args, **kwargs)
        return wrapper
    return decorator
