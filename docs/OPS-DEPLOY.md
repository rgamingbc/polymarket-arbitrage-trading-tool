# OPS Deploy (Cloud) & Rollback

目標：雲端保持運作，本機繼續開發；雲端只部署 main 或 release tag（建議 tag）。

## 重要路徑

    Repo root: /opt/fktools/FKPolyTools_Repo
    API: /opt/fktools/FKPolyTools_Repo/api_src
    Web: /opt/fktools/FKPolyTools_Repo/web_front_src
    Data: /var/lib/polymarket-tools
    Nginx site: /etc/nginx/sites-available/fktools
    Systemd: /etc/systemd/system/fktools-api.service

## 健康檢查（雲端）

    curl -I http://56.68.6.71/crypto-15m | head
    curl -I http://56.68.6.71/crypto-all | head
    curl -sS http://56.68.6.71/api/group-arb/crypto15m/status | head
    curl -sS http://56.68.6.71/api/group-arb/crypto15m/diag | head
    curl -sS http://56.68.6.71/api/group-arb/cryptoall/status | head
    curl -sS http://56.68.6.71/api/group-arb/cryptoall/candidates | head
    curl -sS http://56.68.6.71/api/group-arb/history | head

## 雲端部署（建議：部署 tag）

### A) 本機準備 release tag（本機做）

    cd /Users/user/Documents/trae_projects/polymarket/static/FKPolyTools_Repo
    git status
    git checkout main
    git pull
    git tag -a v20260202-1800 -m release
    git push origin main
    git push origin v20260202-1800

### B) 雲端部署該 tag（EC2 做）

    cd /opt/fktools/FKPolyTools_Repo
    git fetch --all --tags
    git checkout v20260202-1800

    cd /opt/fktools/FKPolyTools_Repo/api_src
    npm ci
    npm run build
    sudo systemctl restart fktools-api

    cd /opt/fktools/FKPolyTools_Repo/web_front_src
    npm ci
    npm run build
    sudo nginx -t
    sudo systemctl reload nginx

### C) 部署後驗收（EC2 或本機都可）

    curl -I http://56.68.6.71/crypto-15m | head
    curl -sS http://56.68.6.71/api/group-arb/crypto15m/diag | head
    curl -I http://56.68.6.71/crypto-all | head
    curl -sS http://56.68.6.71/api/group-arb/cryptoall/status | head

## 回滾（rollback 到上一個 tag）

    cd /opt/fktools/FKPolyTools_Repo
    git fetch --all --tags
    git checkout v20260202-1700

    cd /opt/fktools/FKPolyTools_Repo/api_src
    npm ci
    npm run build
    sudo systemctl restart fktools-api

    cd /opt/fktools/FKPolyTools_Repo/web_front_src
    npm ci
    npm run build
    sudo systemctl reload nginx

## 常見故障與最短排查

### 1) /crypto-15m 500（nginx internal redirection cycle）

通常原因：web_front_src/dist/index.html 不存在或 build 失敗。

    ls -la /opt/fktools/FKPolyTools_Repo/web_front_src/dist/index.html
    sudo tail -n 80 /var/log/nginx/error.log
    cd /opt/fktools/FKPolyTools_Repo/web_front_src
    npm ci
    npm run build
    sudo systemctl reload nginx

### 2) /api 502 或 connection refused

通常原因：nginx upstream port 同 API 監聽 port 不一致。

    sudo ss -lntp | egrep :3000\\|:3001\\|node || true
    sudo systemctl status fktools-api --no-pager
    sudo tail -n 80 /var/log/nginx/error.log

### 3) WS error（crypto15m/ws）

通常原因：nginx 未加 websocket upgrade headers，或 upstream port 不一致。

    sudo grep -n crypto15m/ws /etc/nginx/sites-available/fktools
    sudo nginx -t
    sudo systemctl reload nginx

### 4) build 無聲停止（RAM 太細）

建議加 swap（一次性即可）。

    free -m
    sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    free -m
