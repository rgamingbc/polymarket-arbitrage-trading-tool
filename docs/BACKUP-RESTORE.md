# Backup & Restore (File-based, no EBS Snapshot)

目標：雲端保持運作，備份只用檔案（tar.gz）拉返本機保存；code 用 Git push/pull。

## 必備備份清單（雲端 EC2）

### 1) Runtime data（必備）

    /var/lib/polymarket-tools

常見檔案會包括：
    history.json
    follow-paper-history.json
    auto-redeem.json
    relayer.json
    crypto15m-delta-thresholds.json
    crypto15m-config.json
    cryptoall2-delta-thresholds.json
    cryptoall-delta-thresholds.json
    crypto_all_2.json
    crypto_all_v2.json
    pnl-snapshots.json

### 2) 服務配置（建議備份）

    /etc/nginx/sites-available/fktools
    /etc/systemd/system/fktools-api.service

### 3) 環境變數（敏感，只作加密備份，不入 git）

    /opt/fktools/FKPolyTools_Repo/api_src/.env

## 備份（EC2 上打包）

建議每次 deploy 前做一次。

    TS=$(date +%Y%m%d-%H%M%S)
    sudo mkdir -p /var/backups/fktools
    sudo tar -czf /var/backups/fktools/fktools-$TS.tar.gz /var/lib/polymarket-tools /etc/nginx/sites-available/fktools /etc/systemd/system/fktools-api.service
    sudo ls -lah /var/backups/fktools/fktools-$TS.tar.gz

## 下載備份（拉返本機保存）

在本機執行（把 56.68.6.71 改成你雲端 IP）：

    mkdir -p ~/fktools_backups
    scp -i ~/Downloads/fktools-key.pem ubuntu@56.68.6.71:/var/backups/fktools/fktools-YYYYMMDD-HHMMSS.tar.gz ~/fktools_backups/

## .env 加密備份（可選）

如果你需要備份 .env，但又唔想明文存檔，可用 openssl 以密碼加密。

EC2 上執行：

    TS=$(date +%Y%m%d-%H%M%S)
    sudo mkdir -p /var/backups/fktools
    sudo openssl enc -aes-256-cbc -pbkdf2 -salt -in /opt/fktools/FKPolyTools_Repo/api_src/.env -out /var/backups/fktools/env-$TS.enc
    sudo ls -lah /var/backups/fktools/env-$TS.enc

再用 scp 拉返本機保存：

    scp -i ~/Downloads/fktools-key.pem ubuntu@56.68.6.71:/var/backups/fktools/env-YYYYMMDD-HHMMSS.enc ~/fktools_backups/

## 還原（EC2）

### 1) 停服務

    sudo systemctl stop fktools-api

### 2) 還原 tar.gz（會覆蓋 /var/lib/polymarket-tools）

把備份檔先放到 EC2（例如 /tmp），然後：

    sudo tar -xzf /tmp/fktools-YYYYMMDD-HHMMSS.tar.gz -C /

### 3) reload nginx + 啟動 API

    sudo nginx -t
    sudo systemctl reload nginx
    sudo systemctl start fktools-api

### 4) 驗收

    curl -I http://127.0.0.1/crypto-15m | head
    curl -sS http://127.0.0.1/api/group-arb/crypto15m/diag | head

## 備份保留建議

簡單策略：本機保留最近 10 份，雲端 /var/backups/fktools 亦保留最近 3 份即可。
