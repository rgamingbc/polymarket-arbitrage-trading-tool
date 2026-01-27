import os
import shutil

def patch_db_py():
    target_path = "../FKPolySDK/api_src/db.py"
    if os.path.exists(target_path):
        with open(target_path, "r") as f:
            content = f.read()
            
        old_path_line = 'DB_PATH = os.path.join(os.path.dirname(__file__), "static", "polymarket.db")'
        new_path_line = 'DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "web_front_src", "static", "polymarket.db")'
        
        if old_path_line in content:
            content = content.replace(old_path_line, new_path_line)
            with open(target_path, "w") as f:
                f.write(content)
            print("Patched db.py DB_PATH")
        else:
            print("Could not find DB_PATH line in db.py")

def copy_db():
    src = "polymarket.db"
    dst = "../FKPolySDK/web_front_src/static/polymarket.db"
    if os.path.exists(src):
        shutil.copy2(src, dst)
        print("Copied polymarket.db")

if __name__ == "__main__":
    patch_db_py()
    copy_db()
