import os
import shutil

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET_DIR = os.path.join(BASE_DIR, "FKPolySDK")

def migrate():
    print(f"Migrating from {BASE_DIR} to {TARGET_DIR}")
    
    # Define source paths
    src_services = os.path.join(BASE_DIR, "services")
    src_app = os.path.join(BASE_DIR, "app.py")
    src_db = os.path.join(BASE_DIR, "db.py")
    src_fetcher = os.path.join(BASE_DIR, "fetcher.py")
    src_templates = os.path.join(BASE_DIR, "templates")
    src_static = os.path.join(BASE_DIR, "static")

    # Define target paths
    target_src = os.path.join(TARGET_DIR, "src")
    target_api = os.path.join(TARGET_DIR, "api_src")
    target_front = os.path.join(TARGET_DIR, "web_front_src")
    target_templates = os.path.join(target_front, "templates")
    target_static = os.path.join(target_front, "static")
    
    # Create dirs
    os.makedirs(target_src, exist_ok=True)
    os.makedirs(target_api, exist_ok=True)
    os.makedirs(target_templates, exist_ok=True)
    os.makedirs(target_static, exist_ok=True)
    os.makedirs(os.path.join(TARGET_DIR, "console_src"), exist_ok=True)

    # Copy files
    # Services -> src
    if os.path.exists(src_services):
        for f in os.listdir(src_services):
            if f.endswith(".py"):
                shutil.copy2(os.path.join(src_services, f), os.path.join(target_src, f))
        print("Copied services")

    # App/DB/Fetcher -> api_src
    if os.path.exists(src_app): shutil.copy2(src_app, os.path.join(target_api, "app.py"))
    if os.path.exists(src_db): shutil.copy2(src_db, os.path.join(target_api, "db.py"))
    if os.path.exists(src_fetcher): shutil.copy2(src_fetcher, os.path.join(target_api, "fetcher.py"))
    print("Copied backend files")

    # Templates -> web_front_src/templates
    if os.path.exists(src_templates):
        for f in os.listdir(src_templates):
             shutil.copy2(os.path.join(src_templates, f), os.path.join(target_templates, f))
    print("Copied templates")

    # Static -> web_front_src/static
    if os.path.exists(src_static):
        for f in os.listdir(src_static):
             if os.path.isfile(os.path.join(src_static, f)):
                 shutil.copy2(os.path.join(src_static, f), os.path.join(target_static, f))
    print("Copied static files")
    
    # Fix app.py imports in the new location
    new_app_path = os.path.join(target_api, "app.py")
    with open(new_app_path, "r") as f:
        content = f.read()
    
    # Fix service imports: "from services.xyz" -> "from src.xyz" ?
    # Wait, if we run app.py from api_src, and src is sibling...
    # We need to add parent dir to path or restructure imports.
    # Easiest way: sys.path.append(os.path.join(os.path.dirname(__file__), '..'))
    
    import_fix = '''import sys
import os
sys.path.append(os.path.join(os.path.dirname(__file__), '..'))
from src.wallet_service import WalletService
from src.market_service import MarketService
from src.trade_service import TradeService
from src.copy_trading_service import CopyTradingService
from src.arbitrage_service import ArbitrageService
from src.utils import rate_limit
'''
    # Replace existing service imports
    # They look like: from services.wallet_service import WalletService
    
    lines = content.splitlines()
    new_lines = []
    import_block_inserted = False
    
    for line in lines:
        if "from services." in line:
            if not import_block_inserted:
                new_lines.append(import_fix)
                import_block_inserted = True
            continue # Skip old import
        new_lines.append(line)
        
    # Also update template/static folder paths in Flask init
    # app = Flask(__name__) -> app = Flask(__name__, template_folder="../web_front_src/templates", static_folder="../web_front_src/static")
    
    final_content = "\n".join(new_lines)
    final_content = final_content.replace('app = Flask(__name__)', 'app = Flask(__name__, template_folder="../web_front_src/templates", static_folder="../web_front_src/static")')
    
    with open(new_app_path, "w") as f:
        f.write(final_content)
    print("Patched new app.py")

if __name__ == "__main__":
    migrate()
