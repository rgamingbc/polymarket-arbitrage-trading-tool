import os

# Fix WalletService Imports
WALLET_SERVICE_PATH = "../FKPolySDK/src/wallet_service.py"
if os.path.exists(WALLET_SERVICE_PATH):
    with open(WALLET_SERVICE_PATH, "r") as f:
        content = f.read()
    if "from services.utils import rate_limit" in content:
        content = content.replace("from services.utils import rate_limit", "from src.utils import rate_limit")
        with open(WALLET_SERVICE_PATH, "w") as f:
            f.write(content)
        print("Fixed WalletService imports")

# Fix CopyTradingService Imports
COPY_SERVICE_PATH = "../FKPolySDK/src/copy_trading_service.py"
if os.path.exists(COPY_SERVICE_PATH):
    with open(COPY_SERVICE_PATH, "r") as f:
        content = f.read()
    # services.trade_service -> src.trade_service
    content = content.replace("from services.trade_service import TradeService", "from src.trade_service import TradeService")
    content = content.replace("from services.market_service import MarketService", "from src.market_service import MarketService")
    with open(COPY_SERVICE_PATH, "w") as f:
        f.write(content)
    print("Fixed CopyTradingService imports")
    
# Fix App.py (again just in case)
APP_PATH = "../FKPolySDK/api_src/app.py"
# ... (app.py was already patched by migrate script, but let's double check imports there too if needed)
